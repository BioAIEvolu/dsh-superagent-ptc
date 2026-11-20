import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { appendPluginRecord, pluginRecordOf } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-session-query";
import type { RunState, SnapshotProof } from "../core/index.ts";
import { snapshotDigest, snapshotMatchingProof } from "./digest.ts";
import { HostError, errorMessage } from "./errors.ts";
import { snapshotProofSchema } from "./schema.ts";

export const SNAPSHOT_PROOF_RECORD = "plugin:dsh-super-agent-mode/proof" as const;

declare module "@deepseek-ai/dsh-session/types" {
  interface PluginRecordMap {
    "plugin:dsh-super-agent-mode/proof": SnapshotProof;
  }
}

export interface SnapshotProofStore {
  append(sessionId: string, state: RunState): Promise<SnapshotProof>;
  verify(sessionId: string, state: RunState, expected: SnapshotProof): Promise<SnapshotProof>;
}

function sameProof(left: SnapshotProof, right: SnapshotProof): boolean {
  return left.runId === right.runId && left.snapshotSha256 === right.snapshotSha256 &&
    left.revision === right.revision && left.generation === right.generation && left.nativeEventSeq === right.nativeEventSeq;
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** Experimental native plugin-record seam confirmed for task-29. Proof loss is never treated as success. */
export class NativeSnapshotProofStore implements SnapshotProofStore {
  private readonly ctx: Context;
  private readonly digest: (snapshot: unknown) => string;

  constructor(ctx: Context, digest: (snapshot: unknown) => string = snapshotDigest) {
    this.ctx = ctx;
    this.digest = digest;
  }

  private root(sessionId: string): Agent {
    const agent = this.ctx.agents.get(sessionId as never);
    if (!agent) throw new HostError("SNAPSHOT_PROOF_UNAVAILABLE", "proof writer requires the exact live native root Agent");
    const root = this.ctx.subagents.rootOf(agent);
    if (root.id !== sessionId) throw new HostError("SESSION_NOT_ROOT", "proof records belong only to the native root Session");
    return root;
  }

  async append(sessionId: string, state: RunState): Promise<SnapshotProof> {
    const root = this.root(sessionId);
    const proof: SnapshotProof = {
      runId: state.run.id,
      snapshotSha256: this.digest(state),
      revision: state.run.revision,
      generation: state.run.generation,
      nativeEventSeq: Number(root.session.seq),
    };
    const validated = snapshotProofSchema.parse(proof);
    let seq: number;
    try {
      seq = Number(appendPluginRecord(root.session, SNAPSHOT_PROOF_RECORD, validated));
    } catch (error) {
      throw new HostError("SNAPSHOT_PROOF_WRITE_FAILED", "native snapshot proof append failed before storage commit", { cause: errorMessage(error) });
    }
    if (seq !== validated.nativeEventSeq) {
      throw new HostError("SNAPSHOT_PROOF_WRITE_FAILED", "native proof seq changed at append; storage commit is refused", { expectedSeq: validated.nativeEventSeq, actualSeq: seq });
    }
    let participated: boolean;
    try {
      participated = await this.ctx.sessions.flush(root.session);
    } catch (error) {
      throw new HostError("SNAPSHOT_PROOF_PERSISTENCE_UNCONFIRMED", "proof is visible but durability is unconfirmed; storage/live state is not advanced", { cause: errorMessage(error) });
    }
    if (!participated) {
      throw new HostError("SNAPSHOT_PROOF_PERSISTENCE_UNCONFIRMED", "no Session durability listener confirmed the proof; storage/live state is not advanced");
    }
    return this.verify(sessionId, state, validated);
  }

  async verify(sessionId: string, state: RunState, expected: SnapshotProof): Promise<SnapshotProof> {
    const proof = snapshotProofSchema.safeParse(expected);
    if (!proof.success) throw new HostError("SNAPSHOT_PROOF_MISMATCH", "stored proof does not match the SnapshotProof schema");
    if (state.run.sessionId !== sessionId) {
      throw new HostError("SESSION_RUN_MISMATCH", "snapshot proof verification requires matching native root and Run sessionId");
    }
    let event;
    try {
      const window = await this.ctx.sessionQuery.readEvent({ sessionId: sessionId as never, seq: proof.data.nativeEventSeq as never });
      if (window.session.id !== sessionId) throw new HostError("SESSION_RUN_MISMATCH", "proof readback returned a different native Session");
      event = window.target;
    } catch (error) {
      const code = errorCode(error) === "SESSION_QUERY_EVENT_NOT_FOUND" ? "SNAPSHOT_PROOF_REQUIRED" : "SNAPSHOT_PROOF_UNAVAILABLE";
      throw new HostError(code, "native snapshot proof could not be read back; restore/commit fails closed", { cause: errorMessage(error) });
    }
    const record = pluginRecordOf(event);
    if (!record || record.type !== SNAPSHOT_PROOF_RECORD) {
      throw new HostError("SNAPSHOT_PROOF_REQUIRED", "the referenced native event is not a Super Agent snapshot proof");
    }
    const actual = snapshotProofSchema.safeParse(record.data);
    if (!actual.success || actual.data.nativeEventSeq !== Number(record.seq) || !sameProof(actual.data, proof.data)) {
      throw new HostError("SNAPSHOT_PROOF_MISMATCH", "native proof payload/seq differs from the stored checkpoint proof");
    }
    if (actual.data.runId !== state.run.id || actual.data.revision !== state.run.revision ||
        actual.data.generation !== state.run.generation || !snapshotMatchingProof(state, actual.data, this.digest)) {
      throw new HostError("SNAPSHOT_PROOF_MISMATCH", "native proof does not match the canonical snapshot/run/revision/generation");
    }
    return actual.data;
  }
}
