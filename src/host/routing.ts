import type { Context } from "@deepseek-ai/cordis";
import type { Agent, RequestErrorAction } from "@deepseek-ai/dsh-agent";
import type { LlmFailure } from "@deepseek-ai/dsh-llm";
import type {
  CoreResult,
  Mandate,
  ModelFailureKind,
  ModelPolicy,
  ModelRoute,
  RouteSwitch,
  RunState,
  SetModelPolicyInput,
} from "../core/index.ts";
import type { RouteInspectionDto } from "../shared/types.ts";
import { HostError } from "./errors.ts";
import { canUseSuperTools } from "./access.ts";
import { rootOf } from "./native.ts";
import type { RunRepository } from "./store.ts";

export function routesEqual(left: ModelRoute | null | undefined, right: ModelRoute | null | undefined): boolean {
  return left === null || left === undefined
    ? right === null || right === undefined
    : right !== null && right !== undefined && left.provider === right.provider && left.model === right.model &&
      left.reasoningEffort === right.reasoningEffort;
}

function routeFrom(value: unknown): ModelRoute | null {
  if (value === null || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.provider !== "string" || candidate.provider.length === 0 ||
      typeof candidate.model !== "string" || candidate.model.length === 0) return null;
  return {
    provider: candidate.provider,
    model: candidate.model,
    ...(typeof candidate.reasoningEffort === "string" && candidate.reasoningEffort.length > 0
      ? { reasoningEffort: candidate.reasoningEffort } : {}),
  };
}

export function mandateForNativeAgent(state: RunState | null, agentId: string): { mandate: Mandate; role: "worker" | "reviewer" } | null {
  if (!state) return null;
  for (const item of Object.values(state.workItems)) {
    const mandate = item.currentMandateId ? state.mandates[item.currentMandateId] : undefined;
    if (!mandate || mandate.status === "superseded" || mandate.status === "accepted" || mandate.status === "unknown") continue;
    if ((mandate.workerAgentId ?? mandate.workerId) === agentId) return { mandate, role: "worker" };
    if ((mandate.reviewerAgentId ?? mandate.reviewerId) === agentId) return { mandate, role: "reviewer" };
  }
  return null;
}

export function classifyModelFailure(failure: Pick<LlmFailure, "code" | "status">): ModelFailureKind {
  const code = failure.code.toUpperCase().replaceAll("-", "_");
  if (/^(AUTH|AUTHENTICATION|UNAUTHORIZED|INVALID_API_KEY|INVALID_TOKEN)$/.test(code) || failure.status === 401) return "authentication";
  if (/^(PERMISSION|PERMISSION_DENIED|FORBIDDEN)$/.test(code) || failure.status === 403) return "permission";
  if (/^(INVALID_ARGS|TOOL_ARGS_ERROR|TOOL_INPUT)$/.test(code)) return "tool_input";
  if (/^(BUSINESS_ACCEPTANCE|EVIDENCE_FAIL|GATE_FAIL)$/.test(code)) return "business_acceptance";
  if (/^SNAPSHOT_PROOF/.test(code)) return "snapshot_proof";
  if (/^(WRITE_SCOPE|WRITE_SCOPE_OVERLAP)$/.test(code)) return "write_scope";
  if (/^(ACTOR_MISMATCH|IDENTITY|REVIEWER_SAME_AS_WORKER)$/.test(code)) return "identity";
  if (/^(TIMEOUT|ETIMEDOUT|REQUEST_TIMEOUT)$/.test(code) || failure.status === 408) return "timeout";
  if (/^(RATE_LIMIT|RATE_LIMITED|TOO_MANY_REQUESTS)$/.test(code) || failure.status === 429) return "rate_limit";
  if (/^(QUOTA|QUOTA_EXCEEDED|ACCOUNT_QUOTA|ACCOUNT_QUOTA_EXCEEDED|INSUFFICIENT_QUOTA)$/.test(code)) return code.startsWith("ACCOUNT_") ? "account_quota" : "quota";
  if (/^(PROVIDER_UNAVAILABLE|MODEL_UNAVAILABLE|ROUTE_UNAVAILABLE)$/.test(code)) return "provider_unavailable";
  if (/^(ROUTE_INCOMPATIBLE|MODEL_INCOMPATIBLE|MODEL_NOT_SUPPORTED|UNSUPPORTED_MODEL)$/.test(code)) return "route_incompatible";
  if (/^(TRANSIENT|NETWORK_ERROR|CONNECTION_ERROR|ECONNRESET|ECONNREFUSED|EAI_AGAIN|SOCKET_ERROR|UPSTREAM_UNAVAILABLE)$/.test(code) ||
      failure.status === 502 || failure.status === 503 || failure.status === 504) return "transient";
  return "unknown";
}

function retryable(kind: ModelFailureKind): boolean {
  return kind === "transient" || kind === "timeout" || kind === "rate_limit";
}
function switchable(kind: ModelFailureKind): boolean {
  return kind === "quota" || kind === "account_quota" || kind === "provider_unavailable" || kind === "route_incompatible";
}

export function assertRouteSwitchAllowsWork(mandate: Mandate): void {
  if ((mandate.routeSwitches ?? []).some(entry => entry.status === "requested")) {
    throw new HostError("ROUTE_SWITCH_REQUIRES_NEW_MANDATE", "route-switched execution results require a new Mandate/attempt; old evidence and review cannot release the switched route");
  }
}

export function routePolicyView(state: RunState | null): { modelPolicy: ModelPolicy | null; routeFailures: RunState["routeFailures"] extends Record<string, infer T> ? T[] : never[] } {
  return { modelPolicy: state?.run.modelPolicy ?? null, routeFailures: Object.values(state?.routeFailures ?? {}) };
}

export async function inspectMandateRoute(
  ctx: Context,
  state: RunState | null,
  mandateId: string,
  targetRole: "worker" | "reviewer",
  signal?: AbortSignal,
): Promise<RouteInspectionDto> {
  const mandate = state?.mandates[mandateId];
  if (!mandate) throw new HostError("MANDATE_REQUIRED", "route inspection requires an existing mandate in the current root Run");
  const nativeAgentId = targetRole === "worker" ? mandate.workerAgentId : mandate.reviewerAgentId ?? mandate.reviewerId;
  if (!nativeAgentId) throw new HostError("ROUTE_UNKNOWN", "mandate has no native Agent binding for this role");
  const agent = ctx.agents.get(nativeAgentId as never);
  if (!agent) return { mandateId, targetRole, nativeAgentId, expectedRoute: null, currentRoute: null, lastRequestRoute: null, status: "unknown", reason: "ROUTE_AGENT_UNAVAILABLE" };
  const expectedRoute = (targetRole === "worker" ? mandate.workerRoute : mandate.reviewerRoute) ?? null;
  const currentRoute = routeFrom(agent.model.current());
  let lastRequestRoute: ModelRoute | null = null;
  let requestReadError: string | undefined;
  try {
    lastRequestRoute = routeFrom(await ctx.sessionQuery.inspectSession(agent.id, session => session.requestHeader()?.config, signal));
  } catch {
    requestReadError = "ROUTE_REQUEST_HEADER_UNAVAILABLE";
  }
  const base: RouteInspectionDto = {
    mandateId, targetRole, nativeAgentId, expectedRoute, currentRoute, lastRequestRoute,
    status: "unknown",
    ...(requestReadError ? { reason: requestReadError } : {}),
  };
  if (expectedRoute === null) return { ...base, status: "inherited" };
  const mismatch = (currentRoute !== null && !routesEqual(currentRoute, expectedRoute)) ||
    (lastRequestRoute !== null && !routesEqual(lastRequestRoute, expectedRoute)) ||
    (currentRoute !== null && lastRequestRoute !== null && !routesEqual(currentRoute, lastRequestRoute));
  if (mismatch) return { ...base, status: "unknown", reason: "ROUTE_MISMATCH" };
  if (routesEqual(currentRoute, expectedRoute) || routesEqual(lastRequestRoute, expectedRoute)) return { ...base, status: "matched" };
  return base;
}

function nativeSelection(route: ModelRoute) {
  return {
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort !== undefined ? { reasoningEffort: route.reasoningEffort as never } : {}),
  };
}

export async function switchMandateRoute(
  ctx: Context,
  repository: RunRepository,
  sessionId: string,
  input: { mandateId: string; targetRole: "worker" | "reviewer"; to: ModelRoute; failureCode: string; reason: string },
): Promise<CoreResult<RouteSwitch & { nativeSelection: ModelRoute }>> {
  const state = repository.read(sessionId);
  const mandate = state?.mandates[input.mandateId];
  if (!state || !mandate) throw new HostError("MANDATE_REQUIRED", "route switch requires a mandate in the current root Run");
  const nativeAgentId = input.targetRole === "worker" ? mandate.workerAgentId : mandate.reviewerAgentId ?? mandate.reviewerId;
  const agent = nativeAgentId ? ctx.agents.get(nativeAgentId as never) : undefined;
  if (!agent) throw new HostError("ROUTE_AGENT_UNAVAILABLE", "the bound native Agent is not live; no Core switch or model selection was attempted");
  const guard = { expectedRevision: state.run.revision, expectedGeneration: state.run.generation };
  const result = await repository.transact(sessionId, core => core.switchMandateRoute({ ...guard, ...input }));
  if (!result.ok) return result;
  try {
    agent.model.select(nativeSelection(input.to));
  } catch (error) {
    throw new HostError("ROUTE_SELECT_FAILED_AFTER_COMMIT", "Core route switch is durable, but native model.select failed; inspect before retrying", {
      switchId: result.value.id,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const current = routeFrom(agent.model.current());
  if (!current || !routesEqual(current, input.to)) {
    throw new HostError("ROUTE_MISMATCH", "native model.current did not read back the committed route switch", { switchId: result.value.id });
  }
  return { ...result, value: { ...result.value, nativeSelection: current } };
}

async function waitForRetry(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (delayMs <= 0) return !signal.aborted;
  return new Promise(resolve => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(true); }, delayMs);
    const abort = () => { clearTimeout(timer); resolve(false); };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

export type ModelFailureAdapterOutcome = "retry" | "switch" | "delegate" | "blocked" | "unhandled";

export async function adaptNativeModelFailure(
  ctx: Context,
  repository: RunRepository,
  agent: Agent,
  failure: LlmFailure,
  signal: AbortSignal,
): Promise<ModelFailureAdapterOutcome> {
  if (!await canUseSuperTools(ctx, repository, agent, signal)) return "unhandled";
  const root = rootOf(ctx, agent);
  const state = repository.read(root.id);
  const policy = state?.run.modelPolicy;
  if (!state || !policy) return "delegate"; // no policy preserves native behavior
  const binding = mandateForNativeAgent(state, agent.id);
  if (!binding) return "unhandled";
  const kind = classifyModelFailure(failure);
  const failureCode = failure.code.trim() || "UNKNOWN";
  const guard = { expectedRevision: state.run.revision, expectedGeneration: state.run.generation };
  const recorded = await repository.transact(root.id, core => core.recordRouteFailure({
    ...guard, mandateId: binding.mandate.id, targetRole: binding.role, failureKind: kind, failureCode,
    retrySameRoute: retryable(kind),
  }));
  if (!recorded.ok) return "blocked";
  const delay = Math.max(policy.cooldownMs ?? 0, failure.providerRetryAfterMs ?? 0);
  if (recorded.value.action === "retry_recorded") {
    if (!await waitForRetry(delay, signal)) return "blocked";
    return "retry";
  }
  if (recorded.value.action === "switch_required" && switchable(kind)) {
    const actual = routeFrom(agent.model.current());
    const target = policy.allowedRoutes.find(route => !routesEqual(route, actual));
    if (!target) return "blocked";
    const switched = await switchMandateRoute(ctx, repository, root.id, {
      mandateId: binding.mandate.id, targetRole: binding.role, to: target, failureCode,
      reason: "bounded native model failure switch: " + kind,
    });
    if (!switched.ok) return "blocked";
    if (!await waitForRetry(delay, signal)) return "blocked";
    return "switch";
  }
  if (recorded.value.action === "rejected" && (retryable(kind) || switchable(kind))) return "blocked";
  return "delegate";
}

/** Native next-attempt adapter. No Agent creation and no mutation of an already-dispatched request. */
export function registerModelFailureAdapter(ctx: Context, repository: RunRepository): () => void {
  return ctx.on("agent/request-error", async (payload, next): Promise<RequestErrorAction> => {
    if (payload.signal.aborted) return undefined;
    const outcome = await adaptNativeModelFailure(ctx, repository, payload.agent, payload.failure, payload.signal);
    if (outcome === "retry" || outcome === "switch") return { kind: "retry" };
    if (outcome === "delegate" || outcome === "unhandled") return next();
    return undefined;
  });
}
