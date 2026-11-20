import { randomUUID } from "node:crypto";
import type { CoreDrivers, RunState, SnapshotProof } from "../../src/core/index.ts";
import { snapshotDigest, snapshotMatchingProof } from "../../src/host/digest.ts";
import { HostError } from "../../src/host/errors.ts";
import type { SnapshotProofStore } from "../../src/host/proof.ts";
import type { StoredRunRecord } from "../../src/host/schema.ts";
import type { RunTable } from "../../src/host/store.ts";

export function drivers(): CoreDrivers {
  let id = 0;
  let tick = 0;
  return {
    createId: kind => `${kind}-test-${++id}`,
    now: () => new Date(Date.UTC(2026, 10, 18, 0, 0, 0, ++tick)).toISOString(),
    digestSnapshot: snapshotDigest,
  };
}

export class MemoryTable implements RunTable {
  readonly records = new Map<string, StoredRunRecord>();
  failNextPut = false;
  async put(key: string, value: StoredRunRecord): Promise<void> {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error("synthetic durable write failure");
    }
    this.records.set(key, structuredClone(value));
  }
  get(key: string): StoredRunRecord | undefined {
    const value = this.records.get(key);
    return value ? structuredClone(value) : undefined;
  }
}

export class MemoryProofStore implements SnapshotProofStore {
  readonly events = new Map<string, SnapshotProof[]>();
  failNextAppend = false;

  async append(sessionId: string, state: RunState): Promise<SnapshotProof> {
    if (this.failNextAppend) {
      this.failNextAppend = false;
      throw new HostError("SNAPSHOT_PROOF_PERSISTENCE_UNCONFIRMED", "synthetic proof durability failure");
    }
    const events = this.events.get(sessionId) ?? [];
    const proof: SnapshotProof = {
      runId: state.run.id,
      snapshotSha256: snapshotDigest(state),
      revision: state.run.revision,
      generation: state.run.generation,
      nativeEventSeq: events.length + 1,
    };
    events.push(structuredClone(proof));
    this.events.set(sessionId, events);
    return structuredClone(proof);
  }

  async verify(sessionId: string, state: RunState, expected: SnapshotProof): Promise<SnapshotProof> {
    const proof = this.events.get(sessionId)?.find(item => item.nativeEventSeq === expected.nativeEventSeq);
    if (!proof) throw new HostError("SNAPSHOT_PROOF_REQUIRED", "synthetic native proof event is missing");
    const same = JSON.stringify(proof) === JSON.stringify(expected);
    if (!same || proof.runId !== state.run.id || proof.revision !== state.run.revision ||
        proof.generation !== state.run.generation || !snapshotMatchingProof(state, proof)) {
      throw new HostError("SNAPSHOT_PROOF_MISMATCH", "synthetic native proof does not match snapshot");
    }
    return structuredClone(proof);
  }
}

export const createInput = (sessionId: string) => ({
  sessionId,
  objective: "Ship verified host adapter",
  definitionOfDone: "All mandatory gates pass",
  obligations: [{ id: "obligation-host", kind: "requirement" as const, text: "Use real host evidence" }],
});

export const uniqueId = () => randomUUID();
