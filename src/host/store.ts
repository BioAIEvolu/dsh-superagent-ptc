import { randomUUID } from "node:crypto";
import {
  SuperAgentCore,
  type CoreDrivers,
  type CoreResult,
  type CreateRunInput,
  type NativeRecoveryReceipt,
  type Run,
  type RunState,
  type RecoveryResult,
  type SnapshotProof,
} from "../core/index.ts";
import { HostError } from "./errors.ts";
import { normalizeSnapshotForStorage, snapshotDigest, snapshotMatchingProof } from "./digest.ts";
import type { SnapshotProofStore } from "./proof.ts";
import type { StoredRunRecord } from "./schema.ts";

export interface RunTable {
  get(key: string): StoredRunRecord | undefined;
  put(key: string, value: StoredRunRecord): Promise<void>;
}
export type RecoveryReader = (state: RunState) => Promise<NativeRecoveryReceipt[]>;

export const hostDrivers: CoreDrivers = {
  createId: kind => `${kind}_${randomUUID()}`,
  now: () => new Date().toISOString(),
  digestSnapshot: snapshotDigest,
};

type RestorableCore = SuperAgentCore & {
  restoreSnapshot?: (snapshot: unknown, nativeReceipts?: NativeRecoveryReceipt[], proof?: SnapshotProof) => CoreResult<Run & RecoveryResult>;
};

function copy<T>(value: T): T {
  return structuredClone(value);
}

/** Durable snapshots are authoritative; core instances are disposable write engines. */
export class RunRepository {
  private readonly cores = new Map<string, SuperAgentCore>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly quarantined = new Map<string, string>();

  private readonly table: RunTable;
  private readonly drivers: CoreDrivers;
  private readonly recoveryReader?: RecoveryReader;
  private readonly proofStore?: SnapshotProofStore;

  constructor(table: RunTable, drivers: CoreDrivers = hostDrivers, recoveryReader?: RecoveryReader, proofStore?: SnapshotProofStore) {
    this.table = table;
    this.drivers = drivers;
    this.recoveryReader = recoveryReader;
    this.proofStore = proofStore;
  }

  hasLiveCore(sessionId: string): boolean {
    return this.cores.has(sessionId);
  }

  evaluate(sessionId: string): import("../core/index.ts").GateEvaluation[] {
    const state = this.read(sessionId);
    if (!state) return [];
    const core = this.cores.get(sessionId);
    if (!core) {
      return Object.values(state.workItems).map(item => ({
        workItemId: item.id,
        attempt: item.attempt,
        result: "unknown" as const,
        missingEvidence: [],
        violatedObligations: [],
        staleEvidence: [],
        reasons: ["CORE_RESTORE_UNAVAILABLE"],
      }));
    }
    return Object.keys(state.workItems).map(id => core.evaluateGate(id));
  }

  read(sessionId: string): RunState | null {
    const record = this.table.get(sessionId);
    if (!record) return null;
    // storageDomain.loadAll has already applied storedRunRecordSchema to this record.
    const parsed = record;
    if (parsed.state.run.sessionId !== sessionId) {
      throw new HostError("SESSION_RUN_MISMATCH", "stored run does not belong to the requested root SessionId");
    }
    return copy(parsed.state);
  }

  private async persist(sessionId: string, state: RunState, recoveredAt?: string): Promise<void> {
    state = normalizeSnapshotForStorage(state);
    let proof: SnapshotProof;
    try {
      if (!this.proofStore) throw new HostError("SNAPSHOT_PROOF_UNAVAILABLE", "no native SnapshotProof store is configured; storage/live state is not advanced");
      proof = await this.proofStore.append(sessionId, state);
    } catch (error) {
      this.cores.delete(sessionId);
      const message = error instanceof Error ? error.message : String(error);
      this.quarantined.set(sessionId, message);
      if (error instanceof HostError) throw error;
      throw new HostError("SNAPSHOT_PROOF_FAILED", "snapshot proof failed before storage commit", { cause: message });
    }
    try {
      await this.table.put(sessionId, copy({ schemaVersion: 1, state, proof, ...(recoveredAt ? { recoveredAt } : {}) }));
    } catch (error) {
      this.cores.delete(sessionId);
      const message = error instanceof Error ? error.message : String(error);
      this.quarantined.set(sessionId, message);
      throw new HostError("STORAGE_COMMIT_FAILED", "proof is durable but storage checkpoint failed; root is quarantined and the orphan proof is not a success receipt", { cause: message });
    }
  }

  async verifyProof(sessionId: string): Promise<SnapshotProof> {
    const record = this.table.get(sessionId);
    if (!record) throw new HostError("RUN_NOT_FOUND", "no stored run/proof exists for this root");
    this.read(sessionId);
    if (!this.proofStore) throw new HostError("SNAPSHOT_PROOF_UNAVAILABLE", "no native SnapshotProof reader is configured");
    return this.proofStore.verify(sessionId, record.state, record.proof);
  }

  private provenSnapshot(state: RunState, proof: SnapshotProof): unknown {
    const snapshot = snapshotMatchingProof(state, proof, this.drivers.digestSnapshot);
    if (!snapshot) throw new HostError("SNAPSHOT_PROOF_MISMATCH", "no known v2 snapshot shape matches the verified proof digest");
    return snapshot;
  }

  private async coreForWrite(sessionId: string): Promise<SuperAgentCore> {
    const quarantined = this.quarantined.get(sessionId);
    if (quarantined) throw new HostError("STORAGE_QUARANTINED", "root requires reload after an uncertain storage commit", { cause: quarantined });
    const live = this.cores.get(sessionId);
    if (live) return live;
    const existing = this.read(sessionId);
    if (!existing) return new SuperAgentCore(this.drivers);

    const core = new SuperAgentCore(this.drivers) as RestorableCore;
    if (typeof core.restoreSnapshot !== "function") {
      throw new HostError("CORE_RESTORE_UNAVAILABLE", "stored snapshot is readable, but this core has no public restoreSnapshot; writes fail closed");
    }
    const record = this.table.get(sessionId)!;
    if (!this.proofStore) throw new HostError("SNAPSHOT_PROOF_UNAVAILABLE", "stored snapshot cannot restore without native proof verification");
    const proof = await this.proofStore.verify(sessionId, existing, record.proof);
    const receipts = this.recoveryReader ? await this.recoveryReader(existing) : [];
    const restored = core.restoreSnapshot(this.provenSnapshot(existing, proof), receipts, proof);
    if (!restored.ok) throw new HostError(restored.error.code, restored.error.message, restored.error.details);
    // The frozen host/core contract restores and reconciles exactly once.
    if (restored.state.run.generation <= existing.run.generation) {
      throw new HostError("CORE_RESTORE_CONTRACT_MISMATCH", "restoreSnapshot must advance generation during recovery; refusing an unrestored generation");
    }
    await this.persist(sessionId, restored.state, this.drivers.now());
    this.cores.set(sessionId, core);
    return core;
  }

  async create(sessionId: string, input: CreateRunInput): Promise<CoreResult<Run>> {
    return this.write(sessionId, async () => {
      const quarantined = this.quarantined.get(sessionId);
      if (quarantined) throw new HostError("STORAGE_QUARANTINED", "root requires reload after an uncertain storage commit", { cause: quarantined });
      if (this.read(sessionId)) throw new HostError("INVALID_TRANSITION", "this root session already has a run");
      const core = new SuperAgentCore(this.drivers);
      const result = core.createRun({ ...input, sessionId });
      if (result.ok) {
        await this.persist(sessionId, result.state);
        this.cores.set(sessionId, core);
      }
      return result;
    });
  }

  /** Explicit quarantine recovery from the last natively proven storage record. */
  async recover(sessionId: string): Promise<CoreResult<Run & RecoveryResult>> {
    return this.write(sessionId, async () => {
      const hadQuarantine = this.quarantined.has(sessionId);
      try {
        const record = this.table.get(sessionId);
        if (!record && !hadQuarantine) {
          return {
            ok: false,
            state: null,
            error: { code: "RUN_NOT_FOUND", message: "no stored run/proof exists; fresh root remains available for create" },
            events: [],
          };
        }
        this.cores.delete(sessionId);
        if (!record) throw new HostError("RUN_NOT_FOUND", "cannot recover without a stored snapshot/proof; existing quarantine is retained");
        const existing = this.read(sessionId)!;
        if (!this.proofStore) throw new HostError("SNAPSHOT_PROOF_UNAVAILABLE", "cannot recover without native proof verification; quarantine is retained");
        const proof = await this.proofStore.verify(sessionId, existing, record.proof);
        const receipts = this.recoveryReader ? await this.recoveryReader(existing) : [];
        const core = new SuperAgentCore(this.drivers);
        const restored = core.restoreSnapshot(this.provenSnapshot(existing, proof), receipts, proof);
        if (!restored.ok) {
          this.quarantined.set(sessionId, restored.error.message);
          return restored;
        }
        if (restored.state.run.generation <= existing.run.generation) {
          throw new HostError("CORE_RESTORE_CONTRACT_MISMATCH", "recover must advance generation; quarantine is retained");
        }
        await this.persist(sessionId, restored.state, this.drivers.now());
        this.cores.set(sessionId, core);
        this.quarantined.delete(sessionId);
        return restored;
      } catch (error) {
        this.cores.delete(sessionId);
        this.quarantined.set(sessionId, error instanceof Error ? error.message : String(error));
        throw error;
      }
    });
  }

  async transact<T>(sessionId: string, operation: (core: SuperAgentCore) => CoreResult<T>): Promise<CoreResult<T>> {
    return this.write(sessionId, async () => {
      const core = await this.coreForWrite(sessionId);
      // Do not expose the core's unproven mutation through gate evaluation while proof/storage awaits.
      this.cores.delete(sessionId);
      let result: CoreResult<T>;
      try {
        result = operation(core);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.quarantined.set(sessionId, message);
        throw new HostError("OPERATION_FAILED", "operation threw outside CoreResult; live core remains quarantined", { cause: message });
      }
      if (result.ok) await this.persist(sessionId, result.state);
      if (!this.quarantined.has(sessionId)) this.cores.set(sessionId, core);
      return result;
    });
  }

  private async write<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    const tail = result.then(() => {}, () => {});
    this.queues.set(sessionId, tail);
    try {
      return await result;
    } finally {
      if (this.queues.get(sessionId) === tail) this.queues.delete(sessionId);
    }
  }
}

