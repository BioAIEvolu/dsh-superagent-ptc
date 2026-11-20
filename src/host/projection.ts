import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { GateEvaluation, RunState } from "../core/index.ts";
import { readNativeProjection, type NativeProjection } from "./native.ts";
import { HostError } from "./errors.ts";
import type { RunRepository } from "./store.ts";
import type { RecoveryDto, SnapshotProofDto, SuperProjectionDto } from "../shared/types.ts";

export function projectionBlockReasons(
  state: RunState | null,
  gates: GateEvaluation[],
  recovery: RecoveryDto,
  native?: NativeProjection,
): string[] {
  if (!state) return recovery.status === "unavailable" ? [recovery.reason ?? "CORE_RESTORE_UNAVAILABLE"] : [];
  const reasons: string[] = [];
  if (state.run.status !== "active" && state.run.status !== "completed") reasons.push(`RUN_${state.run.status.toUpperCase()}`);
  const anchor = state.anchors[state.run.currentAnchorId];
  const activeIds = new Set(anchor?.obligationSnapshot ?? []);
  for (const obligation of Object.values(state.obligations)) {
    if (activeIds.has(obligation.id) && obligation.status === "open") reasons.push(`OBLIGATION_OPEN:${obligation.id}`);
    if (activeIds.has(obligation.id) && obligation.status === "violated") reasons.push(`PROHIBITION_VIOLATED:${obligation.id}`);
  }
  for (const mandate of Object.values(state.mandates)) {
    if (mandate.needsStop) reasons.push(`NATIVE_STOP_REQUIRED:${mandate.id}`);
    if (mandate.status === "unknown") reasons.push(`MANDATE_UNKNOWN:${mandate.id}`);
  }
  for (const gate of gates) {
    if (gate.result !== "pass") reasons.push(`GATE_${gate.result.toUpperCase()}:${gate.workItemId}`);
  }
  for (const item of Object.values(state.workItems)) {
    if (!item.nativeTaskId || !native) continue;
    const task = native.agentTeam.tasks.find(entry => entry.id === item.nativeTaskId);
    if (item.status === "accepted" && (!task || task.status !== "completed")) {
      reasons.push(`NATIVE_EXECUTION_MISMATCH:${item.id}`);
    }
  }
  if (recovery.status === "unavailable") reasons.push(recovery.reason ?? "CORE_RESTORE_UNAVAILABLE");
  return [...new Set(reasons)];
}

export function createProjection(
  sessionId: string,
  state: RunState | null,
  native: NativeProjection,
  gates: GateEvaluation[],
  recovery: RecoveryDto,
  observedAt: string,
  proof?: SnapshotProofDto,
): SuperProjectionDto {
  const currentAnchor = state?.anchors[state.run.currentAnchorId] ?? null;
  const activeIds = new Set(currentAnchor?.obligationSnapshot ?? []);
  const obligations = state ? Object.values(state.obligations) : [];
  const value: SuperProjectionDto = {
    schemaVersion: 1,
    sessionId,
    agentPreset: "super-agent",
    run: state?.run ?? null,
    currentAnchor,
    anchors: state ? Object.values(state.anchors) : [],
    obligations,
    openObligations: obligations.filter(item => activeIds.has(item.id) && item.status === "open"),
    workItems: state ? Object.values(state.workItems) : [],
    mandates: state ? Object.values(state.mandates) : [],
    routeFailures: state ? Object.values(state.routeFailures) : [],
    evidence: state ? Object.values(state.evidence) : [],
    decisions: state ? Object.values(state.decisions) : [],
    audit: state?.audit ?? [],
    gates,
    teamEnabled: native.teamEnabled,
    agentTeam: native.agentTeam,
    goal: native.goal,
    subagentCatalog: native.subagentCatalog,
    blockReasons: [],
    recovery,
    ...(proof ? { proof } : {}),
    observedAt,
  };
  value.blockReasons = projectionBlockReasons(state, gates, recovery, native);
  return value;
}

export async function projectRoot(
  ctx: Context,
  repository: RunRepository,
  root: Agent,
  signal?: AbortSignal,
): Promise<SuperProjectionDto> {
  const state = repository.read(root.id);
  const native = await readNativeProjection(ctx, root, signal);
  const after = repository.read(root.id);
  if (state?.run.revision !== after?.run.revision || state?.run.generation !== after?.run.generation) {
    throw new HostError("PROJECTION_CONCURRENT_CHANGE", "Run changed while native state was read; retry the read-only projection");
  }
  let proof: SnapshotProofDto | undefined;
  if (state) {
    try {
      const verified = await repository.verifyProof(root.id);
      proof = { status: "verified", ...verified };
    } catch (error) {
      const reason = error instanceof HostError ? error.code : "SNAPSHOT_PROOF_UNAVAILABLE";
      proof = { status: reason === "SNAPSHOT_PROOF_UNAVAILABLE" ? "unavailable" : "invalid", reason };
    }
  }
  const finalState = repository.read(root.id);
  if (state?.run.revision !== finalState?.run.revision || state?.run.generation !== finalState?.run.generation) {
    throw new HostError("PROJECTION_CONCURRENT_CHANGE", "Run changed during proof readback; retry the read-only projection");
  }
  const proofInvalid = proof !== undefined && proof.status !== "verified";
  const recovery: RecoveryDto = !state ? { status: "not_required" } : proofInvalid
    ? { status: "unavailable", reason: proof?.reason ?? "SNAPSHOT_PROOF_REQUIRED" }
    : repository.hasLiveCore(root.id)
      ? { status: "ready" }
      : { status: "unavailable", reason: "CORE_RESTORE_REQUIRED_ON_NEXT_WRITE" };
  return createProjection(root.id, state, native, repository.evaluate(root.id), recovery, new Date().toISOString(), proof);
}
