import type { Context } from "@deepseek-ai/cordis";
import { defineTool, type ParameterSchemaSpec, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import type {} from "@deepseek-ai/dsh-session-query";
import {
  type CoreError,
  type CoreResult,
  type CreateRunInput,
  type EvidenceKind,
  type EvidenceResult,
  type JsonValue,
  type Mandate,
  type ObligationDelta,
  type RecordEvidenceInput,
  type RunState,
  type WorkItemInput,
  type ModelRoute,
  type SetModelPolicyInput,
} from "../core/index.ts";
import { HostError, errorMessage } from "./errors.ts";
import { observeNativeEvent, readNativeEvents, resultFromNativeFacts, sanitizeModelReceipt } from "./evidence.ts";
import { assertNativeMember, rootOf } from "./native.ts";
import { projectRoot } from "./projection.ts";
import type { RunRepository } from "./store.ts";
import { successfulMutatingEvents } from "./guard.ts";
import { canUseSuperTools } from "./access.ts";
import { assertNativeStandardReviewer, REVIEWER_COMPOSITION_GUIDANCE } from "./reviewer.ts";
import { assertRouteSwitchAllowsWork, inspectMandateRoute, routePolicyView, switchMandateRoute } from "./routing.ts";
import { SUPER_TOOL_PARAMETERS, TOOL_OUTPUT } from "./tool-schemas.ts";

export interface ToolResultValue {
  ok: boolean;
  state: JsonValue;
  value?: JsonValue;
  error?: { code: string; message: string; details?: JsonValue };
}

const toJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const record = (args: unknown): Record<string, unknown> => args as Record<string, unknown>;
const stringArg = (args: Record<string, unknown>, key: string): string => {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") throw new HostError("INVALID_TRANSITION", `${key} is required`);
  return value;
};
const guardArgs = (args: Record<string, unknown>) => ({
  expectedRevision: args.expectedRevision,
  expectedGeneration: args.expectedGeneration,
} as { expectedRevision: number; expectedGeneration: number });

function success<T>(result: CoreResult<T>): ToolResultValue {
  if (!result.ok) return failure(result.error, result.state);
  return { ok: true, state: toJson(result.state), value: toJson(result.value) };
}
function okValue(state: RunState | null, value: unknown): ToolResultValue {
  return { ok: true, state: toJson(state), value: toJson(value) };
}
function failure(error: CoreError | HostError, state: RunState | null = null): ToolResultValue {
  return {
    ok: false,
    state: toJson(state),
    error: { code: error.code, message: error.message, ...(error.details ? { details: toJson(error.details) } : {}) },
  };
}

export function currentMandate(state: RunState | null, mandateId: string): Mandate {
  const mandate = state?.mandates[mandateId];
  if (!mandate) throw new HostError("MANDATE_REQUIRED", "mandate does not exist in the current root run");
  const item = state?.workItems[mandate.workItemId];
  if (!state || !item || item.currentMandateId !== mandate.id || item.status === "superseded" ||
      mandate.status === "superseded" || mandate.generation !== state.run.generation || mandate.attempt !== item.attempt) {
    throw new HostError("MANDATE_STALE", "mandate is rejected, superseded, unknown, or outside the current attempt/generation");
  }
  return mandate;
}

export function reviewerSessionId(mandate: Mandate): string {
  return mandate.reviewerAgentId ?? mandate.reviewerId;
}
function assertRoot(actorId: string, rootId: string): void {
  if (actorId !== rootId) throw new HostError("ACTOR_MISMATCH", "only the native root Lead may perform this operation");
}
async function assertReviewerReadonly(ctx: Context, reviewerId: string): Promise<void> {
  const events = await readNativeEvents(ctx, reviewerId);
  const violations = successfulMutatingEvents(events);
  if (violations.length) throw new HostError("REVIEWER_NOT_READONLY", "reviewer has successful mutating or unknown native tool receipts", {
    receipts: violations.slice(0, 20).map(item => ({ seq: item.seq, toolName: item.toolName, operation: item.operation })),
  });
}

async function executeSuperTool(name: keyof typeof SUPER_TOOL_PARAMETERS, ctx: Context, repository: RunRepository, raw: unknown, exec: ToolRunContext): Promise<ToolResultValue> {
  const args = record(raw);
  const actorId = exec.agent?.id;
  const root = rootOf(ctx, exec.agent);
  if (!actorId) throw new HostError("TOOL_CONTEXT_UNAVAILABLE", "calling Agent has no native SessionId");
  const sessionId = root.id;
  if (name === "super_snapshot") return okValue(repository.read(sessionId), await projectRoot(ctx, repository, root, exec.signal));

  if (name === "super_run") {
    const action = stringArg(args, "action");
    if (action === "show") return okValue(repository.read(sessionId), repository.read(sessionId));
    assertRoot(actorId, sessionId);
    if (action === "create") {
      const input: CreateRunInput = {
        sessionId,
        objective: stringArg(args, "objective"),
        definitionOfDone: stringArg(args, "definitionOfDone"),
        obligations: (args.obligations ?? []) as CreateRunInput["obligations"],
        ...(args.gatePolicy ? { gatePolicy: args.gatePolicy as CreateRunInput["gatePolicy"] } : {}),
      };
      return success(await repository.create(sessionId, input));
    }
    if (action === "recover") return success(await repository.recover(sessionId));
    return success(await repository.transact<unknown>(sessionId, core => {
      if (action === "plan") return core.planWorkItems({ ...guardArgs(args), items: args.items as WorkItemInput[] });
      if (action === "pause") return core.pauseRun(guardArgs(args));
      if (action === "resume") return core.resumeRun(guardArgs(args));
      if (action === "complete") return core.completeRun(guardArgs(args));
      if (action === "replan") return core.applyUserInstruction({
        ...guardArgs(args), runId: repository.read(sessionId)?.run.id ?? "", instruction: stringArg(args, "instruction"),
        obligationDelta: (args.obligationDelta ?? []) as ObligationDelta[],
      });
      throw new HostError("INVALID_TRANSITION", `unknown super_run action ${action}`);
    }));
  }

  if (name === "super_anchor") {
    const action = stringArg(args, "action");
    const state = repository.read(sessionId);
    if (action === "show") return okValue(state, state?.anchors[state.run.currentAnchorId] ?? null);
    if (action === "history") return okValue(state, Object.values(state?.anchors ?? {}).sort((a, b) => a.version - b.version));
    assertRoot(actorId, sessionId);
    if (action !== "create") throw new HostError("INVALID_TRANSITION", `unknown super_anchor action ${action}`);
    return success(await repository.transact(sessionId, core => core.applyUserInstruction({
      ...guardArgs(args), runId: state?.run.id ?? "", instruction: stringArg(args, "instruction"),
      obligationDelta: (args.obligationDelta ?? []) as ObligationDelta[],
    })));
  }

  if (name === "super_route") {
    const action = stringArg(args, "action");
    const state = repository.read(sessionId);
    assertRoot(actorId, sessionId);
    if (action === "show") return okValue(state, routePolicyView(state));
    if (action === "inspect") {
      return okValue(state, await inspectMandateRoute(ctx, state, stringArg(args, "mandateId"), stringArg(args, "targetRole") as "worker" | "reviewer", exec.signal));
    }
    if (action === "set") {
      return success(await repository.transact(sessionId, core => core.setModelPolicy({ ...guardArgs(args), policy: args.policy as SetModelPolicyInput["policy"] })));
    }
    if (action === "switch") {
      return success(await switchMandateRoute(ctx, repository, sessionId, {
        mandateId: stringArg(args, "mandateId"), targetRole: stringArg(args, "targetRole") as "worker" | "reviewer",
        to: args.to as ModelRoute, failureCode: stringArg(args, "failureCode"), reason: stringArg(args, "reason"),
      }));
    }
    throw new HostError("INVALID_TRANSITION", `unknown super_route action ${action}`);
  }

  if (name === "super_mandate") {
    const action = stringArg(args, "action");
    const state = repository.read(sessionId);
    if (action === "show") {
      const mandateId = typeof args.mandateId === "string" ? args.mandateId : undefined;
      return okValue(state, mandateId ? state?.mandates[mandateId] ?? null : Object.values(state?.mandates ?? {}));
    }
    if (action === "report") {
      const mandate = currentMandate(state, stringArg(args, "mandateId"));
      assertRouteSwitchAllowsWork(mandate);
      const boundWorker = mandate.workerAgentId ?? mandate.workerId;
      if (actorId !== boundWorker) throw new HostError("ACTOR_MISMATCH", "calling native Agent is not the bound Worker");
      return success(await repository.transact(sessionId, core => core.reportWorkerDone({
        ...guardArgs(args), mandateId: mandate.id, workerId: mandate.workerId, summary: stringArg(args, "summary"),
      })));
    }
    assertRoot(actorId, sessionId);
    if (action === "prepare") {
      const workerAgentId = stringArg(args, "workerAgentId");
      const reviewerAgentId = stringArg(args, "reviewerAgentId");
      if (workerAgentId === sessionId || reviewerAgentId === sessionId || workerAgentId === reviewerAgentId) {
        throw new HostError("REVIEWER_SAME_AS_WORKER", "Worker and Reviewer must be distinct native descendants, not root or aliases");
      }
      await assertNativeMember(ctx, root, workerAgentId, exec.signal);
      await assertNativeMember(ctx, root, reviewerAgentId, exec.signal);
      return success(await repository.transact(sessionId, core => core.prepareMandate({
        ...guardArgs(args), workItemId: stringArg(args, "workItemId"), workerId: workerAgentId,
        reviewerId: reviewerAgentId, knownFailures: (args.knownFailures ?? []) as string[],
        ...(typeof args.routeReason === "string" ? { routeReason: args.routeReason } : {}),
      })));
    }
    if (action === "bind") {
      const mandate = currentMandate(state, stringArg(args, "mandateId"));
      const workerAgentId = stringArg(args, "workerAgentId");
      if (workerAgentId !== mandate.workerId) throw new HostError("ACTOR_MISMATCH", "native Worker binding differs from prepared Mandate");
      await assertNativeMember(ctx, root, workerAgentId, exec.signal);
      const nativeTaskId = typeof args.nativeTaskId === "string" ? args.nativeTaskId : undefined;
      if (nativeTaskId) {
        if (!ctx.agentTeams.isEnabled(root)) throw new HostError("TEAM_DISABLED", "cannot bind a native Team task while Team is disabled");
        ctx.agentTeams.getTask(root, nativeTaskId as never);
      }
      return success(await repository.transact(sessionId, core => core.bindExecution({
        ...guardArgs(args), mandateId: mandate.id, workerAgentId, ...(nativeTaskId ? { nativeTaskId } : {}),
      })));
    }
    if (action === "bindReviewer") {
      const mandate = currentMandate(state, stringArg(args, "mandateId"));
      const reviewerAgentId = stringArg(args, "reviewerAgentId");
      if (reviewerAgentId === (mandate.workerAgentId ?? mandate.workerId)) throw new HostError("REVIEWER_SAME_AS_WORKER", "Reviewer cannot be the Worker");
      if (reviewerAgentId !== mandate.reviewerId) throw new HostError("ACTOR_MISMATCH", "this adapter binds the prepared native Reviewer; reassignment requires a new Mandate");
      await assertNativeMember(ctx, root, reviewerAgentId, exec.signal);
      const bound = await repository.transact(sessionId, core => core.bindReviewer({
        ...guardArgs(args), mandateId: mandate.id, reviewerAgentId,
      }));
      if (!bound.ok) return success(bound);
      const instruction = [
        "You are the bound native standard Reviewer. Work read-only; Lead must not review on your behalf.",
        `Mandate: ${mandate.id}; Reviewer: ${reviewerAgentId}; WorkItem: ${mandate.workItemId}; attempt: ${mandate.attempt}; generation: ${mandate.generation}; anchorVersion: ${mandate.anchorVersion}.`,
        `Acceptance: ${mandate.acceptance.join(" | ")}`,
        "Available tool declarations in your next native request: super_snapshot, super_evidence, super_review, super_run, super_anchor, super_mandate, super_route.",
        "FIRST ACTION: actually invoke super_snapshot({}) and read the returned JSON. Do not inventory, infer, or discuss tool availability before this call, and do not reply that the tools are unavailable.",
        "NEXT ACTIONS AFTER SNAPSHOT: for this exact Mandate/attempt, record or observe evidence with super_evidence, then super_review evaluate, decide, and release only when every required gate passes. If super_snapshot fails, return its real error and stop.",
        "Use only native read/sessionQuery plus super_snapshot, super_evidence and super_review for your Reviewer work. Do not write/edit files, use shell/run_code, spawn agents, or claim additional permissions.",
        `Next write starts at expectedRevision=${bound.state.run.revision}, expectedGeneration=${bound.state.run.generation}; refresh super_snapshot({}) after every committed action and use current CAS values.`,
        "Worker reported_done is not accepted. Missing/stale/unknown evidence or any write/unknown operation blocks release.",
      ].join("\n");
      try {
        await ctx.subagents.sendMessage(root, reviewerAgentId as never, [{ type: "text", text: instruction }], { signal: exec.signal });
      } catch (error) {
        throw new HostError("REVIEWER_WAKE_FAILED", "Reviewer binding is durable, but native sendMessage failed; the Reviewer was not confirmed awake", {
          mandateId: mandate.id,
          reviewerAgentId,
          cause: error instanceof Error ? error.message : String(error),
        });
      }
      return success(bound);
    }
    throw new HostError("INVALID_TRANSITION", `unknown super_mandate action ${action}`);
  }

  if (name === "super_evidence") {
    const action = stringArg(args, "action");
    const state = repository.read(sessionId);
    if (action === "list") return okValue(state, Object.values(state?.evidence ?? {}));
    const mandate = currentMandate(state, stringArg(args, "mandateId"));
    assertRouteSwitchAllowsWork(mandate);
    const workItemId = stringArg(args, "workItemId");
    if (mandate.workItemId !== workItemId) throw new HostError("MANDATE_REQUIRED", "mandate does not belong to workItemId");
    let input: RecordEvidenceInput;
    if (action === "observe") {
      const observedSessionId = typeof args.sessionId === "string" ? args.sessionId : actorId;
      await assertNativeMember(ctx, root, observedSessionId, exec.signal);
      const eventSeq = args.eventSeq;
      if (typeof eventSeq !== "number") throw new HostError("EVIDENCE_EVENT_NOT_FOUND", "eventSeq is required");
      const observed = await observeNativeEvent(ctx, observedSessionId, eventSeq);
      const kind = stringArg(args, "kind") as EvidenceKind;
      const reviewerId = reviewerSessionId(mandate);
      const violations = observedSessionId === reviewerId ? successfulMutatingEvents(observed.events).filter(item => item.seq === eventSeq) : [];
      const receipt = { ...observed.receipt, ...(violations.length ? { write: true, operation: violations[0].operation } : {}) };
      input = {
        ...guardArgs(args), workItemId, mandateId: mandate.id, attempt: mandate.attempt, kind,
        result: violations.length ? "fail" : resultFromNativeFacts(kind, observed.facts),
        sourceActor: "host", sourceRole: "host", receipt,
        summary: `Host observed ${observed.facts.toolName ?? "native tool"} at ${observedSessionId}#${eventSeq}`,
      };
    } else if (action === "record") {
      const isWorker = actorId === (mandate.workerAgentId ?? mandate.workerId);
      const isReviewer = actorId === reviewerSessionId(mandate);
      if (!isWorker && !isReviewer) throw new HostError("ACTOR_MISMATCH", "model evidence requires the bound native Worker or Reviewer");
      const modelKind = stringArg(args, "kind") as EvidenceKind;
      if (modelKind === "host_receipt" || modelKind === "host_contract" || modelKind === "user_feedback") {
        throw new HostError("ACTOR_MISMATCH", "host receipts/contracts and user feedback cannot be model-recorded; use their authentic source");
      }
      const result = stringArg(args, "result") as EvidenceResult;
      const receipt = sanitizeModelReceipt((args.receipt ?? {}) as Record<string, JsonValue>);
      if (isReviewer && (receipt.write === true || (receipt.operation !== undefined && receipt.operation !== "read"))) {
        throw new HostError("REVIEWER_NOT_READONLY", "Reviewer write/unknown operation receipt fails closed");
      }
      input = {
        ...guardArgs(args), workItemId, mandateId: mandate.id, attempt: mandate.attempt,
        kind: modelKind, result,
        sourceActor: actorId, sourceRole: isWorker ? "worker" : "reviewer", receipt,
        ...(typeof args.summary === "string" ? { summary: args.summary } : {}),
      };
    } else throw new HostError("INVALID_TRANSITION", `unknown super_evidence action ${action}`);
    return success(await repository.transact(sessionId, core => core.recordEvidence(input)));
  }

  if (name === "super_review") {
    const action = stringArg(args, "action");
    const state = repository.read(sessionId);
    if (action === "evaluate") {
      const workItemId = stringArg(args, "workItemId");
      const currentId = state?.workItems[workItemId]?.currentMandateId;
      const current = currentId ? state?.mandates[currentId] : undefined;
      if (current && actorId === reviewerSessionId(current)) {
        await assertNativeStandardReviewer(ctx, exec.agent!, exec.signal);
      }
      const gate = repository.evaluate(sessionId).find(item => item.workItemId === workItemId);
      if (!gate) throw new HostError("ITEM_NOT_FOUND", "work item does not exist");
      return okValue(state, gate);
    }
    const mandate = currentMandate(state, stringArg(args, "mandateId"));
    assertRouteSwitchAllowsWork(mandate);
    const reviewerId = reviewerSessionId(mandate);
    if (actorId !== reviewerId || actorId === (mandate.workerAgentId ?? mandate.workerId)) {
      throw new HostError("ACTOR_MISMATCH", "calling native Agent is not the independent bound Reviewer");
    }
    await assertNativeStandardReviewer(ctx, exec.agent!, exec.signal);
    await assertReviewerReadonly(ctx, reviewerId);
    if (action === "decide") {
      return success(await repository.transact(sessionId, core => core.submitReview({
        ...guardArgs(args), workItemId: stringArg(args, "workItemId"), mandateId: mandate.id,
        attempt: mandate.attempt, reviewerId: mandate.reviewerId,
        result: stringArg(args, "result") as EvidenceResult, evidenceIds: (args.evidenceIds ?? []) as string[],
      })));
    }
    if (action === "release") {
      return success(await repository.transact(sessionId, core => core.releaseWorkItem({
        ...guardArgs(args), workItemId: stringArg(args, "workItemId"), reviewerId: mandate.reviewerId,
      })));
    }
    throw new HostError("INVALID_TRANSITION", `unknown super_review action ${action}`);
  }
  throw new HostError("INVALID_TRANSITION", `unknown tool ${name}`);
}

function safeState(repository: RunRepository, ctx: Context, exec: ToolRunContext): RunState | null {
  try { return repository.read(rootOf(ctx, exec.agent).id); } catch { return null; }
}

function register(ctx: Context, repository: RunRepository, name: keyof typeof SUPER_TOOL_PARAMETERS, description: string, parameters: ParameterSchemaSpec, readAction?: (args: unknown) => boolean): () => void {
  return ctx.tools.register(defineTool({
    name,
    description,
    parameters,
    output: TOOL_OUTPUT,
    ...(readAction ? { isConcurrencySafe: readAction } : {}),
    execute: (async (args: unknown, exec: ToolRunContext) => {
      try { return await executeSuperTool(name, ctx, repository, args, exec); }
      catch (error) {
        if (error instanceof HostError) return failure(error, safeState(repository, ctx, exec));
        return failure(new HostError("HOST_CONTRACT_UNKNOWN", errorMessage(error)), safeState(repository, ctx, exec));
      }
    }) as never,
  }), {
    when: ({ agent, signal }) => canUseSuperTools(ctx, repository, agent, signal),
  });
}

export function registerSuperTools(ctx: Context, repository: RunRepository): () => void {
  const disposers = [
    register(ctx, repository, "super_run", "Operate only the current native root Run. Create/show/plan/pause/resume/replan/recover/complete. Recover verifies the last native SnapshotProof before replacing quarantined state.", SUPER_TOOL_PARAMETERS.super_run, args => record(args).action === "show"),
    register(ctx, repository, "super_anchor", "Create/show/list versioned user-instruction anchors for the current root Run.", SUPER_TOOL_PARAMETERS.super_anchor, args => ["show", "history"].includes(String(record(args).action))),
    register(ctx, repository, "super_mandate", "Prepare/bind native execution and Reviewer SessionIds; bound Worker reports done. No aliases or self-reported roles. " + REVIEWER_COMPOSITION_GUIDANCE, SUPER_TOOL_PARAMETERS.super_mandate, args => record(args).action === "show"),
    register(ctx, repository, "super_evidence", "Record model_reported evidence or observe a real native tool event as host_observed; list current-root evidence.", SUPER_TOOL_PARAMETERS.super_evidence, args => record(args).action === "list"),
    register(ctx, repository, "super_review", "Bound read-only Reviewer evaluates/decides/releases the current attempt using valid evidence. " + REVIEWER_COMPOSITION_GUIDANCE, SUPER_TOOL_PARAMETERS.super_review, args => record(args).action === "evaluate"),
    register(ctx, repository, "super_route", "Root Lead sets/shows the Run model policy, inspects actual native child routes, or performs an authorized bounded switch. Does not create Agents or bypass model pools/permissions.", SUPER_TOOL_PARAMETERS.super_route, args => ["show", "inspect"].includes(String(record(args).action))),
    register(ctx, repository, "super_snapshot", "Read the current native root supervision and native execution projection.", {}, () => true),
  ];
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
