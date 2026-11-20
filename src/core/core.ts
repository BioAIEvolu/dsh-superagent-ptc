import type {
  Anchor,
  ApplyUserInstructionInput,
  AuditEvent,
  BindExecutionInput,
  BindReviewerInput,
  CoreDrivers,
  CoreError,
  CoreResult,
  CreateRunInput,
  Evidence,
  EvidenceKind,
  EvidenceResult,
  GateDecision,
  GateEvaluation,
  HardCheck,
  JsonValue,
  Mandate,
  ModelFailureKind,
  ModelPolicy,
  ModelRoute,
  NativeRecoveryReceipt,
  Obligation,
  ObligationInput,
  PlanWorkItemsInput,
  PrepareMandateInput,
  RecordEvidenceInput,
  RecordRouteFailureInput,
  RecordUserFeedbackInput,
  ReconcileRecoveryInput,
  RecoveryResult,
  ReleaseWorkItemInput,
  ReportWorkerDoneInput,
  RouteFailure,
  RouteSwitch,
  RunState,
  SetModelPolicyInput,
  SnapshotProof,
  StateChanges,
  SubmitReviewInput,
  SwitchMandateRouteInput,
  WorkItem,
  WriteGuard
} from "./types.ts";

const MAX_TEXT = 4000;
const MAX_RECEIPT = 8000;
function forbiddenReceiptKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return /(token|cookie|secret|password|passwd|apikey|credential|privatekey|session|authorization|authentication)/.test(normalized) ||
    normalized === "auth" || normalized === "body" || normalized === "content" ||
    normalized === "transcript" || normalized === "sourcetext";
}

function obligationValid(input: unknown): input is ObligationInput {
  if (!isRecord(input)) return false;
  return textValid(input.id) && textValid(input.text) &&
    ["requirement", "prohibition", "coverage"].includes(String(input.kind)) &&
    (input.sourceId === undefined || textValid(input.sourceId, 1000)) &&
    (input.animation === undefined || textValid(input.animation, 1000)) &&
    (input.requiredEvidence === undefined || (Array.isArray(input.requiredEvidence) && input.requiredEvidence.every(kind =>
      ["build", "unit", "static", "simulated", "host_contract", "runtime_gui", "animation", "hover", "artifact", "source_hash", "build_hash", "loaded_hash", "host_receipt", "numeric_reconcile", "coverage", "user_feedback"].includes(String(kind))
    ))) &&
    (input.coverage === undefined || ["full", "partial", "substitute", "unknown"].includes(String(input.coverage)));
}

function clone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(entry => clone(entry)) as T;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = clone(entry);
  }
  return result as T;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((entry, index) => deepEqual(entry, right[index]));
  }
  const leftObject = left as Record<string, unknown>;
  const rightObject = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftObject);
  const rightKeys = Object.keys(rightObject);
  return leftKeys.length === rightKeys.length && leftKeys.every(key =>
    Object.hasOwn(rightObject, key) && deepEqual(leftObject[key], rightObject[key])
  );
}

function computeChanges(previous: RunState | null, next: RunState): StateChanges {
  const changes: StateChanges = { run: clone(next.run) };
  const maps = ["anchors", "obligations", "workItems", "mandates", "evidence", "decisions", "routeFailures"] as const;
  for (const key of maps) {
    const before = previous?.[key] ?? {};
    const after = next[key];
    const changed: Record<string, (typeof after)[string] | null> = {};
    for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!deepEqual(before[id], after[id])) changed[id] = after[id] ? clone(after[id]) : null;
    }
    if (Object.keys(changed).length > 0) changes[key] = changed as never;
  }
  return changes;
}

function textValid(value: unknown, maximum = MAX_TEXT): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function receiptString(evidence: Evidence | undefined, key: string): string | undefined {
  const value = evidence?.receipt[key];
  return typeof value === "string" ? value : undefined;
}

function receiptNumber(evidence: Evidence | undefined, key: string): number | undefined {
  const value = evidence?.receipt[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function scopeOverlap(left: string, right: string): boolean {
  const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "");
  const a = normalize(left);
  const b = normalize(right);
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}

function validateReceipt(receipt: unknown): string | null {
  if (!isRecord(receipt)) return "receipt must be a JSON object";
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(receipt);
  } catch {
    return "receipt must be serializable JSON";
  }
  if (serialized === undefined) return "receipt must be serializable JSON";
  if (serialized.length > MAX_RECEIPT) return "receipt exceeds 8000 characters";
  const visit = (value: unknown, depth: number): string | null => {
    if (depth > 8) return "receipt nesting exceeds 8 levels";
    if (typeof value === "number" && !Number.isFinite(value)) return "receipt numbers must be finite";
    if (value !== null && !["string", "number", "boolean", "object"].includes(typeof value)) return "receipt contains non-JSON values";
    if (typeof value === "string" && value.length > 2000) return "receipt text exceeds 2000 characters";
    if (Array.isArray(value)) {
      if (value.length > 100) return "receipt array exceeds 100 entries";
      for (const entry of value) {
        const problem = visit(entry, depth + 1);
        if (problem) return problem;
      }
    } else if (value !== null && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        if (forbiddenReceiptKey(key)) return "receipt contains credentials or unrelated body text: " + key;
        const problem = visit(entry, depth + 1);
        if (problem) return problem;
      }
    }
    return null;
  };
  return visit(receipt, 0);
}

function routeShapeValid(value: unknown): boolean {
  return isRecord(value) && textValid(value.provider, 1000) && textValid(value.model, 1000) &&
    (value.reasoningEffort === undefined || textValid(value.reasoningEffort, 1000));
}

function nullableRouteShapeValid(value: unknown): boolean {
  return value === undefined || value === null || routeShapeValid(value);
}

function workItemInputValid(value: unknown): value is PlanWorkItemsInput["items"][number] {
  if (!isRecord(value)) return false;
  return textValid(value.id) && textValid(value.title) &&
    validStringArray(value.dependencies) && validStringArray(value.writeScopes) && validStringArray(value.obligationIds) &&
    validStringArray(value.acceptance, false) &&
    ["code", "visual", "deployment", "numeric_reconcile", "coverage"].includes(String(value.gateProfile)) &&
    (value.mandatory === undefined || typeof value.mandatory === "boolean") &&
    (value.hostContractRequired === undefined || typeof value.hostContractRequired === "boolean");
}

function isMutationReceipt(receipt: Record<string, JsonValue>): boolean {
  if (receipt.write === true) return true;
  const operation = receipt.operation;
  if (operation === undefined) return false;
  if (typeof operation !== "string") return true;
  const normalized = operation.trim().toLowerCase().replaceAll("-", "_");
  const readOnly = new Set([
    "read", "grep", "glob", "search", "list", "test", "build", "verify", "inspect",
    "screenshot", "diff", "status", "show", "get", "query", "observe", "run_tests", "typecheck"
  ]);
  return !readOnly.has(normalized);
}

function coverageMatches(evidence: Evidence, obligation: Obligation): boolean {
  if (receiptString(evidence, "obligationId") === obligation.id) return true;
  const expectedSource = obligation.sourceId;
  return expectedSource !== undefined && expectedSource.trim().length > 0 &&
    receiptString(evidence, "sourceId") === expectedSource;
}

function runProhibitionViolations(state: RunState): string[] {
  const anchor = state.anchors[state.run.currentAnchorId];
  const violations: string[] = [];
  for (const id of anchor.obligationSnapshot) {
    const obligation = state.obligations[id];
    if (!obligation || obligation.kind !== "prohibition" || obligation.status === "waived") continue;
    const violated = obligation.status === "violated" || Object.values(state.evidence).some(entry =>
      entry.generation === state.run.generation && receiptString(entry, "obligationId") === id && entry.receipt.violated === true
    );
    if (violated) violations.push(id);
  }
  return unique(violations);
}

function hasWorkerDoneProof(state: RunState, mandate: Mandate): boolean {
  const direct = state.audit.some(event => event.type === "worker.reported_done" &&
    event.payload.mandateId === mandate.id && event.generation === mandate.generation);
  if (direct) return true;
  return state.audit.some(event => event.type === "run.recovered" && event.generation === mandate.generation &&
    Array.isArray(event.payload.nativeReportedDoneMandateIds) &&
    event.payload.nativeReportedDoneMandateIds.includes(mandate.id));
}

function latestByKind(evidence: Evidence[], kind: EvidenceKind): Evidence | undefined {
  const candidates = evidence.filter(entry => entry.kind === kind);
  return candidates[candidates.length - 1];
}

function error(code: string, message: string, details?: Record<string, JsonValue>): CoreError {
  return details ? { code, message, details } : { code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validStringArray(value: unknown, allowEmpty = true): value is string[] {
  return Array.isArray(value) && (allowEmpty || value.length > 0) && value.every(entry => textValid(entry, 1000));
}

function validateAuditChanges(state: RunState): CoreError | null {
  let runAfter: unknown;
  const latest = {
    anchors: new Map<string, unknown>(),
    obligations: new Map<string, unknown>(),
    workItems: new Map<string, unknown>(),
    mandates: new Map<string, unknown>(),
    evidence: new Map<string, unknown>(),
    decisions: new Map<string, unknown>(),
    routeFailures: new Map<string, unknown>()
  };
  for (const event of state.audit) {
    if (event.changes.run !== undefined) runAfter = event.changes.run;
    for (const key of Object.keys(latest) as (keyof typeof latest)[]) {
      const changes = event.changes[key];
      if (!changes) continue;
      for (const [id, after] of Object.entries(changes)) latest[key].set(id, after);
    }
  }
  if (!runAfter || !deepEqual(runAfter, state.run)) return error("SNAPSHOT_INVALID", "run does not match its latest audit after version");
  for (const key of Object.keys(latest) as (keyof typeof latest)[]) {
    const current = key === "routeFailures" ? state.routeFailures ?? {} : state[key];
    for (const id of new Set([...Object.keys(current), ...latest[key].keys()])) {
      const after = latest[key].get(id);
      if (after === null) {
        if (current[id] !== undefined) return error("SNAPSHOT_INVALID", key + " object was reintroduced after audit deletion: " + id);
      } else if (after === undefined || current[id] === undefined || !deepEqual(after, current[id])) {
        return error("SNAPSHOT_INVALID", key + " object does not match its latest audit after version: " + id);
      }
    }
  }
  return null;
}

function validateSnapshot(value: unknown): CoreError | null {
  const invalid = (message: string) => error("SNAPSHOT_INVALID", message);
  if (!isRecord(value) || value.schemaVersion !== 2) return invalid("schemaVersion must be 2 and snapshot must be an object");
  for (const key of ["anchors", "obligations", "workItems", "mandates", "evidence", "decisions"]) {
    if (!isRecord(value[key])) return invalid(key + " must be an object map");
  }
  if (!isRecord(value.run) || !Array.isArray(value.audit)) return invalid("run and audit are required");
  const run = value.run;
  if (!textValid(run.id) || !textValid(run.sessionId) || !textValid(run.objective) || !textValid(run.definitionOfDone) ||
      !["active", "paused", "blocked", "needs_user", "completed"].includes(String(run.status)) ||
      !Number.isInteger(run.revision) || Number(run.revision) < 1 || !Number.isInteger(run.generation) || Number(run.generation) < 1 ||
      !textValid(run.currentAnchorId) || !textValid(run.createdAt, 100) || !textValid(run.updatedAt, 100) || !isRecord(run.gatePolicy) ||
      !Number.isInteger(run.gatePolicy.maxAttempts) || Number(run.gatePolicy.maxAttempts) < 1 ||
      !Number.isInteger(run.gatePolicy.maxSameFingerprint) || Number(run.gatePolicy.maxSameFingerprint) < 1) {
    return invalid("run fields or CAS/generation budgets are invalid");
  }
  const runId = run.id;
  const revision = Number(run.revision);
  const generation = Number(run.generation);
  const anchors = value.anchors as Record<string, unknown>;
  const obligations = value.obligations as Record<string, unknown>;
  const workItems = value.workItems as Record<string, unknown>;
  const mandates = value.mandates as Record<string, unknown>;
  const evidence = value.evidence as Record<string, unknown>;
  const decisions = value.decisions as Record<string, unknown>;
  if (!anchors[String(run.currentAnchorId)]) return invalid("currentAnchorId must reference an anchor");

  for (const [id, raw] of Object.entries(anchors)) {
    if (!isRecord(raw) || raw.id !== id || !Number.isInteger(raw.version) || Number(raw.version) < 1 ||
        !textValid(raw.latestInstruction) || !textValid(raw.definitionOfDone) || !validStringArray(raw.constraints) ||
        !validStringArray(raw.obligationSnapshot) || !textValid(raw.createdAt, 100)) return invalid("invalid anchor " + id);
    if (raw.supersedes !== undefined && (typeof raw.supersedes !== "string" || !anchors[raw.supersedes])) return invalid("anchor supersedes reference is invalid");
    if (raw.supersededBy !== undefined && (typeof raw.supersededBy !== "string" || !anchors[raw.supersededBy])) return invalid("anchor supersededBy reference is invalid");
    if (new Set(raw.obligationSnapshot).size !== raw.obligationSnapshot.length) return invalid("anchor obligation snapshot contains duplicates");
    for (const obligationId of raw.obligationSnapshot) if (!obligations[obligationId]) return invalid("anchor references unknown obligation");
  }
  const currentAnchor = anchors[String(run.currentAnchorId)] as Record<string, unknown>;
  if (Math.max(...Object.values(anchors).map(raw => Number((raw as Record<string, unknown>).version))) !== currentAnchor.version) {
    return invalid("current anchor must have the latest version");
  }

  for (const [id, raw] of Object.entries(obligations)) {
    if (!isRecord(raw) || raw.id !== id || !["requirement", "prohibition", "coverage"].includes(String(raw.kind)) ||
        !["open", "met", "violated", "waived", "superseded"].includes(String(raw.status)) ||
        !textValid(raw.text) || !validStringArray(raw.evidenceIds) ||
        (raw.userWaiver !== undefined && !textValid(raw.userWaiver)) ||
        (raw.sourceId !== undefined && !textValid(raw.sourceId, 1000)) ||
        (raw.animation !== undefined && !textValid(raw.animation, 1000)) ||
        (raw.requiredEvidence !== undefined && !validStringArray(raw.requiredEvidence))) return invalid("invalid obligation " + id);
    for (const evidenceId of raw.evidenceIds) if (!evidence[evidenceId]) return invalid("obligation references unknown evidence");
  }

  for (const [id, raw] of Object.entries(workItems)) {
    if (!isRecord(raw) || raw.id !== id || !textValid(raw.title) || !validStringArray(raw.writeScopes) ||
        !validStringArray(raw.dependencies) || !validStringArray(raw.acceptance, false) || !validStringArray(raw.obligationIds) ||
        !["code", "visual", "deployment", "numeric_reconcile", "coverage"].includes(String(raw.gateProfile)) ||
        typeof raw.hostContractRequired !== "boolean" || typeof raw.mandatory !== "boolean" ||
        !["held", "ready", "mandated", "running", "reported_done", "verifying", "rework", "accepted", "blocked", "superseded"].includes(String(raw.status)) ||
        !Number.isInteger(raw.attempt) || Number(raw.attempt) < 0 || !isRecord(raw.failureFingerprints) ||
        (raw.nativeTaskId !== undefined && !textValid(raw.nativeTaskId, 1000)) ||
        (raw.currentMandateId !== undefined && (typeof raw.currentMandateId !== "string" || !mandates[raw.currentMandateId]))) {
      return invalid("invalid work item " + id);
    }
    for (const dependency of raw.dependencies) if (!workItems[dependency]) return invalid("work item references unknown dependency");
    for (const obligationId of raw.obligationIds) if (!obligations[obligationId]) return invalid("work item references unknown obligation");
    for (const count of Object.values(raw.failureFingerprints)) if (!Number.isInteger(count) || Number(count) < 0) return invalid("invalid failure fingerprint count");
    if (raw.status === "accepted" && !raw.dependencies.every(dependency => {
      const parent = workItems[dependency];
      return isRecord(parent) && parent.status === "accepted";
    })) return invalid("accepted work item has a non-accepted dependency");
    if (raw.currentMandateId !== undefined) {
      const current = mandates[String(raw.currentMandateId)] as Record<string, unknown>;
      if (current.workItemId !== id) return invalid("current mandate belongs to another work item");
      if (raw.status === "accepted") {
        if (current.status !== "accepted") return invalid("accepted work item lacks accepted current mandate");
        const validPass = Object.values(decisions).some(candidate => isRecord(candidate) &&
          candidate.workItemId === id && candidate.mandateId === current.id && candidate.reviewerId === current.reviewerId &&
          candidate.attempt === raw.attempt && candidate.anchorVersion === current.anchorVersion &&
          candidate.generation === current.generation && candidate.result === "pass" && candidate.invalidated === false);
        if (!validPass) return invalid("accepted work item lacks a valid current pass decision");
      }
    }
    if (raw.status === "accepted" && raw.currentMandateId === undefined) return invalid("accepted work item lacks current mandate");
  }

  for (const [id, raw] of Object.entries(mandates)) {
    if (!isRecord(raw) || raw.id !== id || typeof raw.workItemId !== "string" || !workItems[raw.workItemId] ||
        !Number.isInteger(raw.anchorVersion) || !Number.isInteger(raw.generation) || !Number.isInteger(raw.attempt) ||
        Number(raw.anchorVersion) < 1 || Number(raw.generation) < 1 || Number(raw.generation) > generation || Number(raw.attempt) < 1 ||
        !textValid(raw.workerId) || !textValid(raw.reviewerId) || raw.workerId === raw.reviewerId ||
        !validStringArray(raw.writeScopes) || !validStringArray(raw.acceptance, false) || !validStringArray(raw.knownFailures) ||
        !["prepared", "running", "reported_done", "verifying", "accepted", "superseded", "unknown"].includes(String(raw.status)) ||
        typeof raw.needsStop !== "boolean" || !textValid(raw.mandateText, 20000) ||
        (raw.nativeTaskId !== undefined && !textValid(raw.nativeTaskId, 1000)) ||
        (raw.workerAgentId !== undefined && !textValid(raw.workerAgentId, 1000)) ||
        (raw.reviewerAgentId !== undefined && !textValid(raw.reviewerAgentId, 1000)) ||
        (raw.workerRoute !== undefined && !nullableRouteShapeValid(raw.workerRoute)) ||
        (raw.reviewerRoute !== undefined && !nullableRouteShapeValid(raw.reviewerRoute)) ||
        (raw.routeReason !== undefined && !textValid(raw.routeReason)) ||
        (raw.policyRevision !== undefined && (!Number.isInteger(raw.policyRevision) || Number(raw.policyRevision) < 0)) ||
        (raw.routeSwitches !== undefined && !Array.isArray(raw.routeSwitches))) return invalid("invalid mandate " + id);
    if (Array.isArray(raw.routeSwitches)) {
      for (const routeSwitch of raw.routeSwitches) {
        if (!isRecord(routeSwitch) || !textValid(routeSwitch.id) || routeSwitch.mandateId !== id ||
            !nullableRouteShapeValid(routeSwitch.from) || !nullableRouteShapeValid(routeSwitch.to) ||
            !textValid(routeSwitch.failureCode) || !["requested", "rejected", "exhausted"].includes(String(routeSwitch.status)) ||
            !textValid(routeSwitch.reason) || routeSwitch.attempt !== raw.attempt || routeSwitch.generation !== raw.generation ||
            !textValid(routeSwitch.actor) || !textValid(routeSwitch.createdAt, 100)) return invalid("invalid route switch in mandate " + id);
      }
    }
    const item = workItems[raw.workItemId] as Record<string, unknown>;
    if (item.currentMandateId === id && item.attempt !== raw.attempt) return invalid("current mandate attempt does not match work item");
  }

  const routeFailures = isRecord(value.routeFailures) ? value.routeFailures : {};
  for (const [id, raw] of Object.entries(routeFailures)) {
    if (!isRecord(raw) || raw.id !== id || typeof raw.mandateId !== "string" || !mandates[raw.mandateId] ||
        !nullableRouteShapeValid(raw.route) ||
        !["transient", "timeout", "rate_limit", "quota", "account_quota", "provider_unavailable", "route_incompatible", "authentication", "permission", "tool_input", "business_acceptance", "snapshot_proof", "write_scope", "identity", "unknown"].includes(String(raw.failureKind)) ||
        !textValid(raw.failureCode) || !["rejected", "retry_recorded", "switch_required"].includes(String(raw.action)) ||
        !Number.isInteger(raw.sameRouteRetries) || Number(raw.sameRouteRetries) < 0 ||
        !Number.isInteger(raw.routeSwitches) || Number(raw.routeSwitches) < 0 || !textValid(raw.createdAt, 100)) {
      return invalid("invalid route failure " + id);
    }
  }
  if (run.modelPolicy !== undefined && run.modelPolicy !== null) {
    const policy = run.modelPolicy;
    if (!isRecord(policy) || !["locked", "balanced", "economy", "performance"].includes(String(policy.mode)) ||
        !Array.isArray(policy.allowedRoutes) || !policy.allowedRoutes.every(routeShapeValid) ||
        typeof policy.allowFailureSwitch !== "boolean" || !Number.isInteger(policy.maxSameRouteRetries) ||
        Number(policy.maxSameRouteRetries) < 0 || !Number.isInteger(policy.maxRouteSwitches) || Number(policy.maxRouteSwitches) < 0 ||
        (policy.workerRoute !== undefined && policy.workerRoute !== null && !routeShapeValid(policy.workerRoute)) ||
        (policy.reviewerRoute !== undefined && policy.reviewerRoute !== null && !routeShapeValid(policy.reviewerRoute)) ||
        (policy.cooldownMs !== undefined && (typeof policy.cooldownMs !== "number" || !Number.isFinite(policy.cooldownMs) || policy.cooldownMs < 0)) ||
        !Number.isInteger(policy.revision) || Number(policy.revision) < 1) return invalid("invalid run model policy");
  }

  for (const [id, raw] of Object.entries(evidence)) {
    if (!isRecord(raw) || raw.id !== id || typeof raw.workItemId !== "string" || !workItems[raw.workItemId] ||
        typeof raw.mandateId !== "string" || !mandates[raw.mandateId] || !Number.isInteger(raw.attempt) ||
        !Number.isInteger(raw.anchorVersion) || !Number.isInteger(raw.generation) ||
        !["build", "unit", "static", "simulated", "host_contract", "runtime_gui", "animation", "hover", "artifact", "source_hash", "build_hash", "loaded_hash", "host_receipt", "numeric_reconcile", "coverage", "user_feedback"].includes(String(raw.kind)) ||
        !["pass", "fail", "unknown"].includes(String(raw.result)) || !textValid(raw.sourceActor, 1000) ||
        !["worker", "reviewer", "lead", "host", "user"].includes(String(raw.sourceRole)) || !isRecord(raw.receipt) ||
        typeof raw.summary !== "string" || raw.summary.length > 1000 || !textValid(raw.createdAt, 100)) return invalid("invalid evidence " + id);
    const receiptProblem = validateReceipt(raw.receipt as Record<string, JsonValue>);
    if (receiptProblem) return invalid("evidence receipt is invalid: " + receiptProblem);
    const mandate = mandates[raw.mandateId] as Record<string, unknown>;
    if (mandate.workItemId !== raw.workItemId || mandate.attempt !== raw.attempt ||
        mandate.anchorVersion !== raw.anchorVersion || mandate.generation !== raw.generation) return invalid("evidence/mandate binding mismatch");
  }

  for (const [id, raw] of Object.entries(decisions)) {
    if (!isRecord(raw) || raw.id !== id || typeof raw.workItemId !== "string" || !workItems[raw.workItemId] ||
        typeof raw.mandateId !== "string" || !mandates[raw.mandateId] || !Number.isInteger(raw.attempt) ||
        !Number.isInteger(raw.anchorVersion) || !Number.isInteger(raw.generation) || !textValid(raw.reviewerId) ||
        !["pass", "fail", "unknown"].includes(String(raw.result)) || !validStringArray(raw.evidenceIds) ||
        !validStringArray(raw.reasons) || !textValid(raw.createdAt, 100) || typeof raw.invalidated !== "boolean") return invalid("invalid decision " + id);
    const mandate = mandates[raw.mandateId] as Record<string, unknown>;
    if (mandate.workItemId !== raw.workItemId || mandate.reviewerId !== raw.reviewerId || mandate.attempt !== raw.attempt ||
        mandate.anchorVersion !== raw.anchorVersion || mandate.generation !== raw.generation) return invalid("decision/mandate binding mismatch");
    for (const evidenceId of raw.evidenceIds) {
      const cited = evidence[evidenceId];
      if (!isRecord(cited) || cited.workItemId !== raw.workItemId || cited.mandateId !== raw.mandateId) return invalid("decision cites unknown or mismatched evidence");
    }
  }

  if (value.audit.length !== revision) return invalid("audit length must equal run revision");
  const auditIds = new Set<string>();
  let previousGeneration = 0;
  for (let index = 0; index < value.audit.length; index += 1) {
    const raw = value.audit[index] as unknown;
    if (!isRecord(raw) || !textValid(raw.id) || auditIds.has(raw.id) || raw.runId !== runId || raw.revision !== index + 1 ||
        !Number.isInteger(raw.generation) || Number(raw.generation) < 1 || Number(raw.generation) > generation ||
        Number(raw.generation) < previousGeneration || !textValid(raw.type) || !isRecord(raw.payload) ||
        !isRecord(raw.changes) || !textValid(raw.actor) || !textValid(raw.timestamp, 100)) return invalid("audit log is not append-only CAS-consistent");
    auditIds.add(raw.id);
    previousGeneration = Number(raw.generation);
  }
  if (run.status === "completed") {
    for (const raw of Object.values(workItems)) {
      if (isRecord(raw) && raw.mandatory === true && raw.status !== "accepted") return invalid("completed run has unaccepted mandatory work");
    }
    for (const obligationId of currentAnchor.obligationSnapshot as string[]) {
      const obligation = obligations[obligationId] as Record<string, unknown>;
      if (obligation.status !== "met" && obligation.status !== "waived") return invalid("completed run has open obligations");
    }
    if (runProhibitionViolations(value as unknown as RunState).length > 0) return invalid("completed run has a prohibition violation");
  }
  const changeChain = validateAuditChanges(value as unknown as RunState);
  if (changeChain) return changeChain;
  return null;
}

export class SuperAgentCore {
  private state: RunState | null = null;
  private readonly drivers: CoreDrivers;

  constructor(drivers: CoreDrivers) {
    this.drivers = drivers;
  }

  private normalizeRoute(value: unknown): { ok: true; route: ModelRoute } | { ok: false; error: CoreError } {
    if (!isRecord(value) || !textValid(value.provider, 1000) || !textValid(value.model, 1000) ||
        (value.reasoningEffort !== undefined && !textValid(value.reasoningEffort, 1000))) {
      return { ok: false, error: error("INVALID_INPUT", "route requires bounded provider/model and optional reasoningEffort") };
    }
    return { ok: true, route: {
      provider: value.provider,
      model: value.model,
      ...(typeof value.reasoningEffort === "string" ? { reasoningEffort: value.reasoningEffort } : {})
    } };
  }

  private routeKey(route: ModelRoute | null | undefined): string {
    return route ? route.provider + "/" + route.model + "/" + (route.reasoningEffort ?? "") : "inherit";
  }

  private routeAllowed(route: ModelRoute, allowed: ModelRoute[]): boolean {
    const key = this.routeKey(route);
    return allowed.some(candidate => this.routeKey(candidate) === key);
  }

  setModelPolicy(input: SetModelPolicyInput): CoreResult<ModelPolicy> {
    const state = this.state;
    if (!state) return this.reject(error("RUN_NOT_FOUND", "run does not exist"));
    const guard = this.guard(input) ?? this.mutable();
    if (guard) return this.reject(guard);
    if (!this.off("routing")) {
      if (!isRecord(input.policy) || !["locked", "balanced", "economy", "performance"].includes(String(input.policy.mode)) ||
          !Array.isArray(input.policy.allowedRoutes) || typeof input.policy.allowFailureSwitch !== "boolean") {
        return this.reject(error("INVALID_INPUT", "model policy mode, allowedRoutes and allowFailureSwitch are invalid"));
      }
      const retries: unknown = input.policy.maxSameRouteRetries;
      const switches: unknown = input.policy.maxRouteSwitches;
      if (typeof retries !== "number" || !Number.isInteger(retries) || retries < 0 ||
          typeof switches !== "number" || !Number.isInteger(switches) || switches < 0 ||
          (input.policy.cooldownMs !== undefined && (typeof input.policy.cooldownMs !== "number" || !Number.isFinite(input.policy.cooldownMs) || input.policy.cooldownMs < 0))) {
        return this.reject(error("INVALID_INPUT", "route retry/switch/cooldown budgets must be finite non-negative integers"));
      }
      const routes: ModelRoute[] = [];
      const seen = new Set<string>();
      for (const raw of input.policy.allowedRoutes) {
        const normalized = this.normalizeRoute(raw);
        if (!normalized.ok) return this.reject(normalized.error);
        const key = this.routeKey(normalized.route);
        if (seen.has(key)) return this.reject(error("INVALID_INPUT", "allowedRoutes contains a duplicate route"));
        seen.add(key);
        routes.push(normalized.route);
      }
      if (input.policy.mode === "locked" && routes.length === 0) {
        return this.reject(error("INVALID_INPUT", "locked model policy requires a non-empty allowed route pool"));
      }
      for (const [key, raw] of [["workerRoute", input.policy.workerRoute], ["reviewerRoute", input.policy.reviewerRoute]] as const) {
        if (raw === undefined) continue;
        const normalized = this.normalizeRoute(raw);
        if (!normalized.ok) return this.reject(normalized.error);
        if (!this.routeAllowed(normalized.route, routes)) {
          return this.reject(error("ROUTE_NOT_ALLOWED", key + " must be in the explicitly authorized allowedRoutes pool"));
        }
      }
    }
    const next = clone(state);
    const policy: ModelPolicy = {
      ...clone(input.policy),
      allowedRoutes: input.policy.allowedRoutes.map(route => clone(route)),
      revision: (state.run.modelPolicy?.revision ?? 0) + 1
    };
    next.run.modelPolicy = policy;
    return this.commit(next, "route.policy.updated", "lead", {
      policyRevision: policy.revision,
      mode: policy.mode,
      allowedRouteCount: policy.allowedRoutes.length,
      allowFailureSwitch: policy.allowFailureSwitch,
      maxSameRouteRetries: policy.maxSameRouteRetries,
      maxRouteSwitches: policy.maxRouteSwitches
    }, policy);
  }

  recordRouteFailure(input: RecordRouteFailureInput): CoreResult<RouteFailure> {
    const state = this.state;
    if (!state) return this.reject(error("RUN_NOT_FOUND", "run does not exist"));
    const guard = this.guard(input) ?? this.mutable();
    if (guard) return this.reject(guard);
    const mandate = state.mandates[input.mandateId];
    if (!mandate) return this.reject(error("MANDATE_REQUIRED", "route failure requires a mandate"));
    if (!this.off("generation") && mandate.generation !== state.run.generation) {
      return this.reject(error("STALE_GENERATION", "route failure mandate belongs to an old generation"));
    }
    const retryable: ModelFailureKind[] = ["transient", "timeout", "rate_limit"];
    const switchable: ModelFailureKind[] = ["quota", "account_quota", "provider_unavailable", "route_incompatible"];
    if (!textValid(input.failureCode) || !textValid(input.mandateId)) {
      return this.reject(error("INVALID_INPUT", "failureCode and mandateId are required bounded text"));
    }
    const retry = input.retrySameRoute === true;
    const canRetry = retryable.includes(input.failureKind);
    const canSwitch = switchable.includes(input.failureKind);
    const policy = state.run.modelPolicy;
    const targetRole = input.targetRole ?? "worker";
    if (targetRole !== "worker" && targetRole !== "reviewer") return this.reject(error("INVALID_INPUT", "failure targetRole must be worker or reviewer"));
    const targetRoute = targetRole === "reviewer" ? mandate.reviewerRoute : mandate.workerRoute;
    const sameRouteRetries = Object.values(state.routeFailures).filter(entry =>
      entry.mandateId === mandate.id && this.routeKey(entry.route) === this.routeKey(targetRoute) && entry.action === "retry_recorded"
    ).length;
    const routeSwitches = mandate.routeSwitches?.filter(entry => entry.status === "requested").length ?? 0;
    const hasAlternateRoute = policy?.allowedRoutes.some(candidate => this.routeKey(candidate) !== this.routeKey(targetRoute)) ?? false;
    let action: RouteFailure["action"] = "rejected";
    if (retry && canRetry && sameRouteRetries < (policy?.maxSameRouteRetries ?? 0)) action = "retry_recorded";
    else if (canSwitch && policy?.allowFailureSwitch === true && hasAlternateRoute && routeSwitches < policy.maxRouteSwitches) action = "switch_required";
    const next = clone(state);
    const failure: RouteFailure = {
      id: this.drivers.createId("route-failure"),
      mandateId: mandate.id,
      route: clone(targetRoute ?? null),
      failureKind: input.failureKind,
      failureCode: input.failureCode,
      action,
      sameRouteRetries: action === "retry_recorded" ? sameRouteRetries + 1 : sameRouteRetries,
      routeSwitches,
      createdAt: this.drivers.now()
    };
    next.routeFailures[failure.id] = failure;
    if (action === "rejected" && (canRetry || canSwitch)) {
      next.run.status = "blocked";
    }
    return this.commit(next, "route.failure.recorded", "host", {
      failureId: failure.id,
      mandateId: mandate.id,
      failureKind: failure.failureKind,
      failureCode: failure.failureCode,
      action,
      sameRouteRetries: failure.sameRouteRetries,
      routeSwitches: failure.routeSwitches,
      blocked: next.run.status === "blocked"
    }, failure);
  }

  switchMandateRoute(input: SwitchMandateRouteInput): CoreResult<RouteSwitch> {
    const state = this.state;
    if (!state) return this.reject(error("RUN_NOT_FOUND", "run does not exist"));
    const guard = this.guard(input) ?? this.mutable();
    if (guard) return this.reject(guard);
    const mandate = state.mandates[input.mandateId];
    if (!mandate) return this.reject(error("MANDATE_REQUIRED", "route switch requires a mandate"));
    if (!this.off("generation") && mandate.generation !== state.run.generation) {
      return this.reject(error("STALE_GENERATION", "route switch mandate belongs to an old generation"));
    }
    if (!textValid(input.failureCode) || !textValid(input.reason)) {
      return this.reject(error("INVALID_INPUT", "route switch failureCode and reason are required bounded text"));
    }
    const normalized = this.normalizeRoute(input.to);
    if (!normalized.ok) return this.reject(normalized.error);
    const policy = state.run.modelPolicy;
    const prior = mandate.routeSwitches ?? [];
    if (!this.off("routing")) {
      if (!policy?.allowFailureSwitch) return this.reject(error("ROUTE_SWITCH_DISABLED", "failure switching is not enabled by model policy"));
      if (!this.routeAllowed(normalized.route, policy.allowedRoutes)) return this.reject(error("ROUTE_NOT_ALLOWED", "target route is not explicitly allowed"));
      const priorFailures = Object.values(state.routeFailures).filter(entry => entry.mandateId === mandate.id && entry.failureCode === input.failureCode);
      if (!priorFailures.some(entry => entry.action === "switch_required")) {
        return this.reject(error("ROUTE_FAILURE_REQUIRED", "route switch requires a classified switchable failure record"));
      }
      if (prior.filter(entry => entry.status === "requested").length >= policy.maxRouteSwitches) {
        return this.reject(error("ROUTE_BUDGET_EXHAUSTED", "route switch budget is exhausted"));
      }
      const targetKey = input.targetRole === "reviewer" ? "reviewerRoute" : "workerRoute";
      if (this.routeKey(mandate[targetKey]) === this.routeKey(normalized.route)) {
        return this.reject(error("ROUTE_SWITCH_INVALID", "target route must differ from the current role route"));
      }
    }
    const next = clone(state);
    const nextMandate = next.mandates[mandate.id];
    const targetKey = input.targetRole === "reviewer" ? "reviewerRoute" : "workerRoute";
    const previousRoute = nextMandate[targetKey] ?? null;
    nextMandate[targetKey] = normalized.route;
    const routeSwitch: RouteSwitch = {
      id: this.drivers.createId("route-switch"),
      mandateId: mandate.id,
      from: clone(previousRoute),
      to: clone(normalized.route),
      failureCode: input.failureCode,
      status: "requested",
      reason: input.reason,
      attempt: mandate.attempt,
      generation: mandate.generation,
      actor: "lead",
      createdAt: this.drivers.now()
    };
    nextMandate.routeSwitches = [...prior, routeSwitch];
    return this.commit(next, "route.switch.requested", "lead", {
      switchId: routeSwitch.id,
      mandateId: mandate.id,
      targetRole: input.targetRole,
      from: this.routeKey(previousRoute),
      to: this.routeKey(normalized.route),
      failureCode: input.failureCode,
      attempt: mandate.attempt,
      generation: mandate.generation,
      newExecutionRequiresNewMandate: true
    }, routeSwitch);
  }

  snapshot(): RunState | null {
    return this.state ? clone(this.state) : null;
  }

  protected off(_check: HardCheck): boolean {
    return false;
  }

  private reject<T>(problem: CoreError): CoreResult<T> {
    return { ok: false, state: this.state ? clone(this.state) : null, error: problem, events: [] };
  }

  private guard(input: WriteGuard): CoreError | null {
    const state = this.state;
    if (!state) return error("RUN_NOT_FOUND", "run does not exist");
    if (!isRecord(input)) return error("INVALID_INPUT", "write guard must be an object");
    if (!this.off("revision") && input.expectedRevision !== state.run.revision) {
      return error("STALE_REVISION", "expectedRevision does not match", {
        expectedRevision: input.expectedRevision,
        actualRevision: state.run.revision
      });
    }
    if (!this.off("generation") && input.expectedGeneration !== state.run.generation) {
      return error("STALE_GENERATION", "expectedGeneration does not match", {
        expectedGeneration: input.expectedGeneration,
        actualGeneration: state.run.generation
      });
    }
    return null;
  }

  private mutable(): CoreError | null {
    if (this.state?.run.status === "paused" || this.state?.run.status === "completed") {
      return error("INVALID_TRANSITION", "run is not writable in status " + this.state.run.status);
    }
    return null;
  }

  private commit<T>(
    next: RunState,
    type: string,
    actor: string,
    payload: Record<string, JsonValue>,
    value: T,
    base: RunState | null = this.state
  ): CoreResult<T> {
    next.run.revision += 1;
    next.run.updatedAt = this.drivers.now();
    const event: AuditEvent = {
      id: this.drivers.createId("audit"),
      runId: next.run.id,
      revision: next.run.revision,
      generation: next.run.generation,
      type,
      payload: clone(payload),
      changes: computeChanges(base, next),
      actor,
      timestamp: next.run.updatedAt
    };
    next.audit.push(event);
    this.state = next;
    return { ok: true, state: clone(next), value: clone(value), events: [clone(event)] };
  }

  createRun(input: CreateRunInput): CoreResult<RunState["run"]> {
    if (this.state) return this.reject(error("INVALID_TRANSITION", "core instance already owns a run"));
    if (!isRecord(input) || !Array.isArray(input.obligations) ||
        (input.gatePolicy !== undefined && !isRecord(input.gatePolicy))) {
      return this.reject(error("INVALID_INPUT", "createRun requires an object, obligations array and optional gatePolicy object"));
    }
    if (!textValid(input.sessionId) || !textValid(input.objective) || !textValid(input.definitionOfDone)) {
      return this.reject(error("INVALID_TRANSITION", "sessionId, objective and definitionOfDone are required bounded text"));
    }
    const ids = new Set<string>();
    for (const obligation of input.obligations) {
      if (!obligationValid(obligation) || ids.has(obligation.id)) {
        return this.reject(error("INVALID_TRANSITION", "obligation ids must be unique and text must be bounded"));
      }
      ids.add(obligation.id);
    }
    const maxAttempts: unknown = input.gatePolicy?.maxAttempts ?? 4;
    const maxSameFingerprint: unknown = input.gatePolicy?.maxSameFingerprint ?? 2;
    if (typeof maxAttempts !== "number" || !Number.isInteger(maxAttempts) || maxAttempts < 1 ||
        typeof maxSameFingerprint !== "number" || !Number.isInteger(maxSameFingerprint) || maxSameFingerprint < 1) {
      return this.reject(error("INVALID_TRANSITION", "failure budgets must be positive integers"));
    }
    const timestamp = this.drivers.now();
    const runId = this.drivers.createId("run");
    const anchorId = this.drivers.createId("anchor");
    const obligations: Record<string, Obligation> = {};
    for (const source of input.obligations) {
      obligations[source.id] = { ...clone(source), status: "open", evidenceIds: [] };
    }
    const anchor: Anchor = {
      id: anchorId,
      version: 1,
      latestInstruction: input.objective,
      definitionOfDone: input.definitionOfDone,
      constraints: [],
      obligationSnapshot: [...ids],
      createdAt: timestamp
    };
    const state: RunState = {
      schemaVersion: 2,
      run: {
        id: runId,
        sessionId: input.sessionId,
        objective: input.objective,
        definitionOfDone: input.definitionOfDone,
        status: "active",
        currentAnchorId: anchorId,
        revision: 1,
        generation: 1,
        gatePolicy: { maxAttempts, maxSameFingerprint },
        modelPolicy: null,
        createdAt: timestamp,
        updatedAt: timestamp
      },
      anchors: { [anchorId]: anchor },
      obligations,
      workItems: {},
      mandates: {},
      routeFailures: {},
      evidence: {},
      decisions: {},
      audit: []
    };
    this.state = state;
    const event: AuditEvent = {
      id: this.drivers.createId("audit"),
      runId,
      revision: 1,
      generation: 1,
      type: "run.created",
      payload: { objective: input.objective, anchorVersion: 1 },
      changes: computeChanges(null, state),
      actor: "lead",
      timestamp
    };
    state.audit.push(event);
    return { ok: true, state: clone(state), value: clone(state.run), events: [clone(event)] };
  }

  private validateSnapshotSemantics(snapshot: RunState): CoreError | null {
    if (snapshot.run.status === "completed") {
      const completion = snapshot.audit[snapshot.audit.length - 1];
      if (!completion || completion.type !== "run.completed" || completion.revision !== snapshot.run.revision ||
          completion.generation !== snapshot.run.generation) {
        return error("SNAPSHOT_INVALID", "completed snapshot requires a final matching run.completed audit event");
      }
    }
    const anchor = snapshot.anchors[snapshot.run.currentAnchorId];
    for (const obligationId of anchor.obligationSnapshot) {
      const obligation = snapshot.obligations[obligationId];
      if (obligation.status === "waived") {
        const waiverAudited = snapshot.audit.some(event => event.type === "anchor.applied" &&
          Array.isArray(event.payload.changedObligationIds) && event.payload.changedObligationIds.includes(obligationId));
        if (!obligation.userWaiver || !waiverAudited) {
          return error("SNAPSHOT_INVALID", "waived obligation lacks bounded user waiver and anchor audit", { obligationId });
        }
      }
      if (obligation.status === "met") {
        const acceptedProof = Object.values(snapshot.workItems).some(item =>
          item.status === "accepted" && item.obligationIds.includes(obligationId));
        if (obligation.evidenceIds.length === 0 || !acceptedProof) {
          return error("SNAPSHOT_INVALID", "met obligation lacks evidence and accepted work proof", { obligationId });
        }
      }
    }
    for (const item of Object.values(snapshot.workItems).filter(entry => !entry.mandatory)) {
      const planningProof = snapshot.audit.some(event => event.type === "work.planned" &&
        isRecord(event.payload.mandatoryByItem) && event.payload.mandatoryByItem[item.id] === false);
      if (!planningProof) return error("SNAPSHOT_INVALID", "non-mandatory work item lacks planning audit provenance", { workItemId: item.id });
    }
    for (const item of Object.values(snapshot.workItems).filter(entry => entry.status === "accepted")) {
      const mandate = item.currentMandateId ? snapshot.mandates[item.currentMandateId] : undefined;
      if (!mandate) return error("SNAPSHOT_INVALID", "accepted item lacks its mandate");
      const decisions = Object.values(snapshot.decisions).filter(decision =>
        decision.workItemId === item.id && decision.mandateId === mandate.id && !decision.invalidated
      );
      const decision = decisions[decisions.length - 1];
      if (!decision || decision.result !== "pass" || decision.reviewerId !== mandate.reviewerId ||
          decision.attempt !== item.attempt || decision.anchorVersion !== mandate.anchorVersion ||
          decision.generation !== mandate.generation || decision.evidenceIds.length === 0) {
        return error("SNAPSHOT_INVALID", "accepted item lacks a complete current pass decision chain");
      }
      if (!hasWorkerDoneProof(snapshot, mandate)) {
        return error("SNAPSHOT_INVALID", "accepted item lacks its worker reported_done audit precursor");
      }
      const historical = clone(snapshot);
      historical.run.generation = mandate.generation;
      const citedGate = this.evaluateOn(historical, item.id, decision.evidenceIds);
      const fullGate = this.evaluateOn(historical, item.id);
      if (citedGate.result !== "pass" || fullGate.result !== "pass") {
        return error("SNAPSHOT_INVALID", "accepted item fails decision-evidence-gate semantic revalidation", {
          workItemId: item.id,
          citedReasons: citedGate.reasons,
          fullReasons: fullGate.reasons
        });
      }
    }
    return null;
  }

  private createRecoveryReviewMandate(state: RunState, historical: Mandate): Mandate {
    const item = state.workItems[historical.workItemId];
    historical.status = "reported_done";
    historical.needsStop = false;
    const recovery: Mandate = {
      ...historical,
      id: this.drivers.createId("mandate"),
      generation: state.run.generation,
      attempt: item.attempt + 1,
      writeScopes: [...historical.writeScopes],
      acceptance: [...historical.acceptance],
      knownFailures: [...historical.knownFailures],
      status: "reported_done",
      needsStop: false
    };
    state.mandates[recovery.id] = recovery;
    item.currentMandateId = recovery.id;
    item.attempt = recovery.attempt;
    item.status = "reported_done";
    return recovery;
  }

  restoreSnapshot(
    snapshot: unknown,
    nativeReceipts: NativeRecoveryReceipt[] = [],
    proof?: SnapshotProof
  ): CoreResult<RunState["run"] & RecoveryResult> {
    if (this.state) return this.reject(error("INVALID_TRANSITION", "restoreSnapshot requires a fresh core without a run"));
    const validation = this.off("restore") ? null : validateSnapshot(snapshot);
    if (validation) return this.reject(validation);
    if (!isRecord(snapshot)) return this.reject(error("SNAPSHOT_INVALID", "snapshot must be an object"));
    if (!this.off("proof")) {
      if (!proof) return this.reject(error("SNAPSHOT_PROOF_REQUIRED", "restore requires a native root Session snapshot proof"));
      if (!textValid(proof.runId, 1000) || !textValid(proof.snapshotSha256, 256) || !Number.isInteger(proof.revision) ||
          !Number.isInteger(proof.generation) || !Number.isInteger(proof.nativeEventSeq) || proof.nativeEventSeq < 1) {
        return this.reject(error("SNAPSHOT_PROOF_MISMATCH", "snapshot proof fields are invalid"));
      }
      const candidateRun = snapshot.run as Record<string, unknown>;
      let actualDigest: string;
      try {
        actualDigest = this.drivers.digestSnapshot(snapshot);
      } catch {
        return this.reject(error("SNAPSHOT_PROOF_MISMATCH", "snapshot digest could not be computed"));
      }
      if (proof.runId !== candidateRun.id || proof.revision !== candidateRun.revision ||
          proof.generation !== candidateRun.generation || proof.snapshotSha256 !== actualDigest) {
        return this.reject(error("SNAPSHOT_PROOF_MISMATCH", "snapshot proof does not match digest/revision/generation", {
          expectedRevision: proof.revision,
          actualRevision: candidateRun.revision as number,
          expectedGeneration: proof.generation,
          actualGeneration: candidateRun.generation as number
        }));
      }
    }
    const next = clone(snapshot) as unknown as RunState;
    const semanticValidation = this.off("restore") ? null : this.validateSnapshotSemantics(next);
    if (semanticValidation) return this.reject(semanticValidation);
    if (!Array.isArray(nativeReceipts)) return this.reject(error("INVALID_INPUT", "nativeReceipts must be an array"));
    next.routeFailures ??= {};
    const recoveryBaseline = clone(next);
    const previousGeneration = next.run.generation;
    const receipts = new Map<string, NativeRecoveryReceipt>();
    for (const receipt of nativeReceipts) {
      if (!isRecord(receipt) || !textValid(receipt.mandateId, 1000) || !next.mandates[receipt.mandateId] || receipts.has(receipt.mandateId) ||
          !["running", "reported_done", "unknown", "failed"].includes(receipt.status)) {
        return this.reject(error("SNAPSHOT_INVALID", "native recovery receipt is invalid, duplicate or unknown"));
      }
      receipts.set(receipt.mandateId, receipt);
    }
    next.run.generation += 1;
    if (next.run.status === "completed") next.run.status = "active";
    const unknownMandateIds: string[] = [];
    const nativeReportedDoneMandateIds: string[] = [];
    for (const mandate of Object.values(next.mandates)) {
      if (mandate.status !== "running") continue;
      const receipt = receipts.get(mandate.id);
      const item = next.workItems[mandate.workItemId];
      if (!receipt || receipt.status === "unknown" || receipt.status === "failed") {
        mandate.status = "unknown";
        mandate.needsStop = false;
        item.status = "verifying";
        unknownMandateIds.push(mandate.id);
      } else if (receipt.status === "reported_done") {
        const recovery = this.createRecoveryReviewMandate(next, mandate);
        nativeReportedDoneMandateIds.push(recovery.id);
      }
    }
    if (next.run.status === "paused") next.run.status = "active";
    const value = { ...next.run, unknownMandateIds };
    return this.commit(next, "run.recovered", "host", {
      previousGeneration,
      generation: next.run.generation,
      unknownMandateIds,
      nativeReportedDoneMandateIds,
      restored: true,
      nativeEventSeq: proof?.nativeEventSeq ?? null,
      snapshotSha256: proof?.snapshotSha256 ?? null
    }, value, recoveryBaseline);
  }

  applyUserInstruction(input: ApplyUserInstructionInput): CoreResult<Anchor> {
    const state = this.state;
    if (!state) return this.reject(error("RUN_NOT_FOUND", "run does not exist"));
    const guard = this.guard(input) ?? this.mutable();
    if (guard) return this.reject(guard);
    if (input.runId !== state.run.id) return this.reject(error("RUN_NOT_FOUND", "runId does not belong to this core"));
    if (!textValid(input.instruction)) return this.reject(error("INVALID_TRANSITION", "instruction must be bounded non-empty text"));
    if (!Array.isArray(input.obligationDelta)) return this.reject(error("INVALID_INPUT", "obligationDelta must be an array"));
    for (const delta of input.obligationDelta) {
      if (!isRecord(delta) || !["add", "amend", "waive", "supersede"].includes(String(delta.op))) {
        return this.reject(error("INVALID_INPUT", "obligationDelta entries must be objects with a supported op"));
      }
      if ((delta.op === "amend" || delta.op === "waive" || delta.op === "supersede") && !textValid(delta.id)) {
        return this.reject(error("INVALID_INPUT", "obligation delta id must be bounded non-empty text"));
      }
      if (delta.op === "add" && !isRecord(delta.obligation)) {
        return this.reject(error("INVALID_INPUT", "add delta requires an obligation object"));
      }
      if (delta.op === "amend" && !isRecord(delta.patch)) {
        return this.reject(error("INVALID_INPUT", "amend delta requires a patch object"));
      }
      if (delta.op === "supersede" && !isRecord(delta.replacement)) {
        return this.reject(error("INVALID_INPUT", "supersede delta requires a replacement object"));
      }
    }
    const next = clone(state);
    const oldAnchor = next.anchors[next.run.currentAnchorId];
    const changed = new Set<string>();
    for (const delta of input.obligationDelta) {
      if (delta.op === "add") {
        const source = delta.obligation;
        if (!this.off("input") && !obligationValid(source)) {
          return this.reject(error("INVALID_TRANSITION", "added obligation fails text/schema bounds"));
        }
        if (next.obligations[source.id] && next.obligations[source.id].status !== "superseded") {
          return this.reject(error("INVALID_TRANSITION", "obligation already exists: " + source.id));
        }
        next.obligations[source.id] = { ...clone(source), status: "open", evidenceIds: [] };
        changed.add(source.id);
        continue;
      }
      const current = next.obligations[delta.id];
      if (!current || !oldAnchor.obligationSnapshot.includes(delta.id) || current.status === "superseded") {
        return this.reject(error("OBLIGATION_OPEN", "cannot change unknown or inactive obligation: " + delta.id));
      }
      changed.add(delta.id);
      if (delta.op === "waive") {
        if (!textValid(delta.reason)) return this.reject(error("INVALID_TRANSITION", "waiver reason is required"));
        current.status = "waived";
        current.userWaiver = delta.reason;
      } else if (delta.op === "amend") {
        const preservedId = current.id;
        Object.assign(current, clone(delta.patch));
        current.id = preservedId;
        current.status = "open";
        current.userWaiver = undefined;
        current.evidenceIds = [];
        if (!this.off("input") && !obligationValid(current)) {
          return this.reject(error("INVALID_TRANSITION", "amended obligation fails text/schema bounds"));
        }
      } else {
        current.status = "superseded";
        const replacement = delta.replacement;
        if (!this.off("input") && !obligationValid(replacement)) {
          return this.reject(error("INVALID_TRANSITION", "replacement obligation fails text/schema bounds"));
        }
        if (next.obligations[replacement.id] && next.obligations[replacement.id].status !== "superseded") {
          return this.reject(error("INVALID_TRANSITION", "replacement obligation already exists: " + replacement.id));
        }
        next.obligations[replacement.id] = { ...clone(replacement), status: "open", evidenceIds: [] };
        changed.add(replacement.id);
      }
    }
    const anchorId = this.drivers.createId("anchor");
    const anchor: Anchor = {
      id: anchorId,
      version: oldAnchor.version + 1,
      supersedes: oldAnchor.id,
      latestInstruction: input.instruction,
      definitionOfDone: oldAnchor.definitionOfDone,
      constraints: [...oldAnchor.constraints],
      obligationSnapshot: Object.values(next.obligations)
        .filter(obligation => obligation.status !== "superseded")
        .map(obligation => obligation.id),
      createdAt: this.drivers.now()
    };
    next.anchors[anchorId] = anchor;
    oldAnchor.supersededBy = anchorId;
    next.run.currentAnchorId = anchorId;

    const affected = new Set<string>();
    if (!this.off("anchor")) {
      for (const item of Object.values(next.workItems)) {
        if (item.obligationIds.some(id => changed.has(id))) affected.add(item.id);
      }
      let expanded = true;
      while (expanded) {
        expanded = false;
        for (const item of Object.values(next.workItems)) {
          if (!affected.has(item.id) && item.dependencies.some(id => affected.has(id))) {
            affected.add(item.id);
            expanded = true;
          }
        }
      }
      for (const itemId of affected) {
        const item = next.workItems[itemId];
        item.status = "superseded";
        for (const decision of Object.values(next.decisions)) {
          if (decision.workItemId === itemId) decision.invalidated = true;
        }
        for (const mandate of Object.values(next.mandates)) {
          if (mandate.workItemId === itemId && mandate.status !== "superseded") {
            mandate.needsStop = mandate.status === "running";
            mandate.status = "superseded";
          }
        }
      }
    }
    if (next.run.status === "blocked" || next.run.status === "needs_user") next.run.status = "active";
    return this.commit(next, "anchor.applied", "user", {
      anchorId,
      anchorVersion: anchor.version,
      changedObligationIds: [...changed],
      affectedWorkItemIds: [...affected],
      classification: input.obligationDelta.every(delta => delta.op === "add") && input.obligationDelta.length > 0
        ? "user_scope_expansion"
        : "user_instruction"
    }, anchor);
  }

  planWorkItems(input: PlanWorkItemsInput): CoreResult<WorkItem[]> {
    const state = this.state;
    if (!state) return this.reject(error("RUN_NOT_FOUND", "run does not exist"));
    const guard = this.guard(input) ?? this.mutable();
    if (guard) return this.reject(guard);
    if (!Array.isArray(input.items) || input.items.length === 0) {
      return this.reject(error("INVALID_INPUT", "items must be a non-empty array"));
    }
    if (input.items.some(item => !workItemInputValid(item))) {
      return this.reject(error("INVALID_INPUT", "work item has missing or invalid dependencies/scopes/acceptance/obligations/gateProfile/flags"));
    }
    const next = clone(state);
    const all: Record<string, WorkItem> = { ...next.workItems };
    const anchor = next.anchors[next.run.currentAnchorId];
    const batchIds = new Set<string>();
    for (const source of input.items) {
      if (!textValid(source.id) || !textValid(source.title) || source.acceptance.length === 0 ||
          source.acceptance.some(entry => !textValid(entry)) || source.writeScopes.some(scope => !textValid(scope, 1000))) {
        return this.reject(error("INVALID_TRANSITION", "work item text, acceptance and write scopes must be valid"));
      }
      const existing = next.workItems[source.id];
      const existingMandate = existing?.currentMandateId ? next.mandates[existing.currentMandateId] : undefined;
      const recoveryReplan = existing && existingMandate && existingMandate.generation !== next.run.generation &&
        (existing.status === "accepted" || existing.status === "reported_done");
      const unknownReplan = existing?.status === "verifying" && existingMandate?.status === "unknown";
      const replannable = existing && (existing.status === "superseded" || recoveryReplan || unknownReplan);
      if (batchIds.has(source.id) || (existing && !replannable)) {
        return this.reject(error("INVALID_TRANSITION", "duplicate active work item: " + source.id));
      }
      batchIds.add(source.id);
      if (source.obligationIds.some(id => !anchor.obligationSnapshot.includes(id))) {
        return this.reject(error("OBLIGATION_OPEN", "work item references an unknown obligation: " + source.id));
      }
      const previous = next.workItems[source.id];
      if (recoveryReplan && previous && (!deepEqual(previous.title, source.title) ||
          !deepEqual(previous.writeScopes, source.writeScopes) ||
          !deepEqual(previous.acceptance, source.acceptance) ||
          !deepEqual(previous.obligationIds, source.obligationIds))) {
        return this.reject(error("INVALID_TRANSITION", "recovery replan must preserve title, obligations, acceptance and write scopes"));
      }
      if (previous && replannable) {
        for (const obligationId of previous.obligationIds) {
          const obligation = next.obligations[obligationId];
          if (obligation?.status === "met") obligation.status = "open";
        }
      }
      all[source.id] = {
        id: source.id,
        nativeTaskId: previous?.nativeTaskId,
        title: source.title,
        writeScopes: [...source.writeScopes],
        dependencies: [...source.dependencies],
        acceptance: [...source.acceptance],
        obligationIds: [...source.obligationIds],
        gateProfile: source.gateProfile,
        hostContractRequired: source.hostContractRequired ?? false,
        mandatory: source.mandatory ?? true,
        status: "held",
        attempt: previous?.attempt ?? 0,
        failureFingerprints: clone(previous?.failureFingerprints ?? {})
      };
    }
    if (!this.off("dependency")) {
      for (const item of Object.values(all)) {
        for (const dependency of item.dependencies) {
          if (!all[dependency]) {
            return this.reject(error("DEPENDENCY_NOT_ACCEPTED", "unknown dependency", { itemId: item.id, dependency }));
          }
        }
      }
      const visiting = new Set<string>();
      const visited = new Set<string>();
      const visit = (id: string): boolean => {
        if (visiting.has(id)) return true;
        if (visited.has(id)) return false;
        visiting.add(id);
        for (const dependency of all[id].dependencies) {
          if (visit(dependency)) return true;
        }
        visiting.delete(id);
        visited.add(id);
        return false;
      };
      for (const id of Object.keys(all)) {
        if (visit(id)) return this.reject(error("DEPENDENCY_CYCLE", "dependency cycle includes " + id));
      }
    }
    const reaches = (from: string, target: string, seen = new Set<string>()): boolean => {
      if (seen.has(from)) return false;
      seen.add(from);
      for (const dependency of all[from]?.dependencies ?? []) {
        if (dependency === target || reaches(dependency, target, seen)) return true;
      }
      return false;
    };
    if (!this.off("writeScope")) {
      const items = Object.values(all).filter(item => item.status !== "accepted" && item.status !== "superseded");
      for (let left = 0; left < items.length; left += 1) {
        for (let right = left + 1; right < items.length; right += 1) {
          const a = items[left];
          const b = items[right];
          if (reaches(a.id, b.id) || reaches(b.id, a.id)) continue;
          for (const scopeA of a.writeScopes) {
            for (const scopeB of b.writeScopes) {
              if (scopeOverlap(scopeA, scopeB)) {
                return this.reject(error("WRITE_SCOPE_OVERLAP", "parallel work items have overlapping write scopes", {
                  leftItem: a.id,
                  rightItem: b.id,
                  leftScope: scopeA,
                  rightScope: scopeB
                }));
              }
            }
          }
        }
      }
    }
    const planned: WorkItem[] = [];
    for (const source of input.items) {
      const item = all[source.id];
      item.status = item.dependencies.every(id => next.workItems[id]?.status === "accepted") ? "ready" : "held";
      next.workItems[item.id] = item;
      planned.push(item);
    }
    const mandatoryByItem: Record<string, JsonValue> = {};
    for (const item of planned) mandatoryByItem[item.id] = item.mandatory;
    return this.commit(next, "work.planned", "lead", {
      itemIds: planned.map(item => item.id),
      mandatoryByItem
    }, planned);
  }

  prepareMandate(input: PrepareMandateInput): CoreResult<Mandate> {
    const state = this.state;
    if (!state) return this.reject(error("RUN_NOT_FOUND", "run does not exist"));
    const guard = this.guard(input) ?? this.mutable();
    if (guard) return this.reject(guard);
    const item = state.workItems[input.workItemId];
    if (!item) return this.reject(error("ITEM_NOT_FOUND", "work item does not exist"));
    if (!this.off("failureBudget")) {
      if (item.attempt >= state.run.gatePolicy.maxAttempts) {
        return this.reject(error("MAX_ATTEMPTS", "work item attempt budget exhausted"));
      }
      if (Object.values(item.failureFingerprints).some(count => count >= state.run.gatePolicy.maxSameFingerprint)) {
        return this.reject(error("REPEATED_FAILURE", "repeated failure fingerprint budget exhausted"));
      }
    }
    const allowed = item.status === "ready" || item.status === "rework" || (this.off("failureBudget") && item.status === "blocked");
    if (!allowed) return this.reject(error("INVALID_TRANSITION", "mandate requires ready/rework work item"));
    if (!this.off("dependency") && !item.dependencies.every(id => state.workItems[id]?.status === "accepted")) {
      return this.reject(error("DEPENDENCY_NOT_ACCEPTED", "all dependencies must be accepted"));
    }
    if (!this.off("actor") && input.workerId === input.reviewerId) {
      return this.reject(error("REVIEWER_SAME_AS_WORKER", "worker and reviewer must be different identities"));
    }
    if (!Array.isArray(input.knownFailures)) return this.reject(error("INVALID_INPUT", "knownFailures must be a string array"));
    if (!textValid(input.workerId) || !textValid(input.reviewerId) || input.knownFailures.some(entry => !textValid(entry))) {
      return this.reject(error("INVALID_TRANSITION", "worker, reviewer and knownFailures must be bounded text"));
    }
    const next = clone(state);
    const nextItem = next.workItems[item.id];
    const anchor = next.anchors[next.run.currentAnchorId];
    const modelPolicy = next.run.modelPolicy;
    if (modelPolicy?.mode === "locked" && (!modelPolicy.workerRoute || !modelPolicy.reviewerRoute)) {
      return this.reject(error("ROUTE_NOT_ALLOWED", "locked policy requires explicit workerRoute and reviewerRoute"));
    }
    const attempt = nextItem.attempt + 1;
    const mandateId = this.drivers.createId("mandate");
    const mandateText = [
      "Super Agent Mandate",
      "Objective: " + next.run.objective,
      "Definition of done: " + anchor.definitionOfDone,
      "Work item: " + nextItem.title,
      "Anchor version: " + anchor.version,
      "Attempt: " + attempt,
      "Worker: " + input.workerId,
      "Reviewer (read-only, native standard tool preset): " + input.reviewerId,
      "Worker route: " + this.routeKey(modelPolicy?.workerRoute ?? null),
      "Reviewer route: " + this.routeKey(modelPolicy?.reviewerRoute ?? null),
      "Route reason: " + (input.routeReason ?? "inherit current native model pool"),
      "Write scopes: " + (nextItem.writeScopes.join(", ") || "none"),
      "Acceptance: " + nextItem.acceptance.join(" | "),
      "Known failures: " + (input.knownFailures.join(" | ") || "none"),
      "Return: structured summary plus evidence receipts with kind/result/sourceActor/sourceRole; worker done is not acceptance."
    ].join(String.fromCharCode(10));
    const mandate: Mandate = {
      id: mandateId,
      workItemId: nextItem.id,
      anchorVersion: anchor.version,
      generation: next.run.generation,
      attempt,
      workerId: input.workerId,
      reviewerId: input.reviewerId,
      writeScopes: [...nextItem.writeScopes],
      acceptance: [...nextItem.acceptance],
      knownFailures: [...input.knownFailures],
      status: "prepared",
      needsStop: false,
      mandateText,
      workerRoute: clone(modelPolicy?.workerRoute ?? null),
      reviewerRoute: clone(modelPolicy?.reviewerRoute ?? null),
      routeReason: input.routeReason ?? "inherit current native model pool",
      policyRevision: modelPolicy?.revision ?? 0,
      routeSwitches: []
    };
    next.mandates[mandateId] = mandate;
    nextItem.currentMandateId = mandateId;
    nextItem.attempt = attempt;
    nextItem.status = "mandated";
    next.run.status = "active";
    return this.commit(next, "mandate.prepared", "lead", { mandateId, workItemId: nextItem.id, attempt }, mandate);
  }

  bindExecution(input: BindExecutionInput): CoreResult<Mandate> {
    const state = this.state;
    if (!state) return this.reject(error("RUN_NOT_FOUND", "run does not exist"));
    const guard = this.guard(input) ?? this.mutable();
    if (guard) return this.reject(guard);
    const mandate = state.mandates[input.mandateId];
    if (!mandate) return this.reject(error("MANDATE_REQUIRED", "mandate does not exist"));
    if (mandate.status !== "prepared") return this.reject(error("INVALID_TRANSITION", "only prepared mandate can bind execution"));
    if (!this.off("anchor") && mandate.anchorVersion !== state.anchors[state.run.currentAnchorId].version &&
        state.workItems[mandate.workItemId].status === "superseded") {
      return this.reject(error("ANCHOR_STALE", "mandate belongs to a superseded anchor"));
    }
    if (!this.off("generation") && mandate.generation !== state.run.generation) {
      return this.reject(error("STALE_GENERATION", "mandate belongs to an old generation"));
    }
    if (!this.off("input") && ((input.nativeTaskId !== undefined && !textValid(input.nativeTaskId, 1000)) ||
        (input.workerAgentId !== undefined && !textValid(input.workerAgentId, 1000)))) {
      return this.reject(error("INVALID_TRANSITION", "native execution identifiers must be bounded non-empty text"));
    }
    const next = clone(state);
    const bound = next.mandates[mandate.id];
    bound.nativeTaskId = input.nativeTaskId;
    bound.workerAgentId = input.workerAgentId;
    bound.status = "running";
    const item = next.workItems[bound.workItemId];
    item.nativeTaskId = input.nativeTaskId ?? item.nativeTaskId;
    item.status = "running";
    return this.commit(next, "execution.bound", "lead", {
      mandateId: bound.id,
      nativeTaskId: input.nativeTaskId ?? null,
      workerAgentId: input.workerAgentId ?? null
    }, bound);
  }

  bindReviewer(input: BindReviewerInput): CoreResult<Mandate> {
    const state = this.state;
    if (!state) return this.reject(error("RUN_NOT_FOUND", "run does not exist"));
    const guard = this.guard(input) ?? this.mutable();
    if (guard) return this.reject(guard);
    const mandate = state.mandates[input.mandateId];
    if (!mandate) return this.reject(error("MANDATE_REQUIRED", "mandate does not exist"));
    if (!["prepared", "running", "reported_done"].includes(mandate.status)) {
      return this.reject(error("INVALID_TRANSITION", "reviewer binding requires an active pre-review mandate"));
    }
    if (!this.off("generation") && mandate.generation !== state.run.generation) {
      return this.reject(error("STALE_GENERATION", "reviewer binding belongs to an old generation"));
    }
    if (!this.off("input") && !textValid(input.reviewerAgentId, 1000)) {
      return this.reject(error("INVALID_TRANSITION", "reviewerAgentId must be bounded non-empty text"));
    }
    const next = clone(state);
    next.mandates[mandate.id].reviewerAgentId = input.reviewerAgentId;
    return this.commit(next, "reviewer.bound", "lead", {
      mandateId: mandate.id,
      reviewerAgentId: input.reviewerAgentId
    }, next.mandates[mandate.id]);
  }

  reportWorkerDone(input: ReportWorkerDoneInput): CoreResult<Mandate> {
    const state = this.state;
    if (!state) return this.reject(error("RUN_NOT_FOUND", "run does not exist"));
    const guard = this.guard(input) ?? this.mutable();
    if (guard) return this.reject(guard);
    if (!textValid(input.summary)) return this.reject(error("INVALID_TRANSITION", "summary must be bounded non-empty text"));
    const mandate = state.mandates[input.mandateId];
    if (!mandate) return this.reject(error("MANDATE_REQUIRED", "mandate does not exist"));
    if (!this.off("actor") && mandate.workerId !== input.workerId) {
      return this.reject(error("ACTOR_MISMATCH", "workerId does not match mandate"));
    }
    if (!this.off("generation") && mandate.generation !== state.run.generation) {
      return this.reject(error("STALE_GENERATION", "worker report belongs to an old mandate generation"));
    }
    if (mandate.status !== "running") return this.reject(error("INVALID_TRANSITION", "worker done requires running mandate"));
    if (!this.off("anchor") && mandate.anchorVersion !== state.anchors[state.run.currentAnchorId].version &&
        state.workItems[mandate.workItemId].status === "superseded") {
      return this.reject(error("ANCHOR_STALE", "worker report belongs to a superseded anchor"));
    }
    const next = clone(state);
    next.mandates[mandate.id].status = "reported_done";
    next.workItems[mandate.workItemId].status = "reported_done";
    return this.commit(next, "worker.reported_done", input.workerId, {
      mandateId: mandate.id,
      summary: input.summary
    }, next.mandates[mandate.id]);
  }

  recordEvidence(input: RecordEvidenceInput): CoreResult<Evidence> {
    const state = this.state;
    if (!state) return this.reject(error("RUN_NOT_FOUND", "run does not exist"));
    const guard = this.guard(input) ?? this.mutable();
    if (guard) return this.reject(guard);
    if (!Number.isInteger(input.attempt) || !textValid(input.workItemId) || !textValid(input.mandateId) ||
        !["build", "unit", "static", "simulated", "host_contract", "runtime_gui", "animation", "hover", "artifact", "source_hash", "build_hash", "loaded_hash", "host_receipt", "numeric_reconcile", "coverage", "user_feedback"].includes(String(input.kind)) ||
        !["pass", "fail", "unknown"].includes(String(input.result)) ||
        !["worker", "reviewer", "lead", "host", "user"].includes(String(input.sourceRole)) ||
        (input.summary !== undefined && (typeof input.summary !== "string" || input.summary.length > 1000))) {
      return this.reject(error("INVALID_INPUT", "evidence fields, enums, attempt or summary are invalid"));
    }
    const item = state.workItems[input.workItemId];
    const mandate = state.mandates[input.mandateId];
    if (!item) return this.reject(error("ITEM_NOT_FOUND", "work item does not exist"));
    if (!mandate || mandate.workItemId !== item.id) return this.reject(error("MANDATE_REQUIRED", "mandate does not match work item"));
    if (!this.off("evidenceFreshness") && (input.attempt !== item.attempt || input.attempt !== mandate.attempt)) {
      return this.reject(error("MANDATE_STALE", "evidence attempt is not current"));
    }
    if (!this.off("anchor") && mandate.anchorVersion !== state.anchors[state.run.currentAnchorId].version &&
        (mandate.status === "superseded" || item.status === "superseded")) {
      return this.reject(error("ANCHOR_STALE", "evidence mandate belongs to a superseded anchor"));
    }
    if (!this.off("generation") && mandate.generation !== state.run.generation) {
      return this.reject(error("STALE_GENERATION", "evidence mandate belongs to an old generation"));
    }
    if (!this.off("input") && !textValid(input.sourceActor, 1000)) {
      return this.reject(error("INVALID_TRANSITION", "evidence sourceActor must be bounded non-empty text"));
    }
    const receiptProblem = this.off("receipt") ? null : validateReceipt(input.receipt);
    if (receiptProblem) return this.reject(error("INVALID_TRANSITION", receiptProblem));

    const next = clone(state);
    const evidenceId = this.drivers.createId("evidence");
    const degraded = input.receipt.timeout === true || input.receipt.unreadable === true || input.receipt.malformed === true;
    const evidence: Evidence = {
      id: evidenceId,
      workItemId: item.id,
      mandateId: mandate.id,
      attempt: input.attempt,
      anchorVersion: mandate.anchorVersion,
      generation: mandate.generation,
      kind: input.kind,
      result: degraded ? "unknown" : input.result,
      sourceActor: input.sourceActor,
      sourceRole: input.sourceRole,
      receipt: clone(input.receipt),
      summary: input.summary ?? "",
      createdAt: this.drivers.now()
    };
    next.evidence[evidenceId] = evidence;
    const violatedObligationId = receiptString(evidence, "obligationId");
    if (!this.off("prohibition") && evidence.receipt.violated === true && violatedObligationId) {
      const obligation = next.obligations[violatedObligationId];
      if (obligation?.kind === "prohibition" && obligation.status !== "waived" && obligation.status !== "superseded") {
        obligation.status = "violated";
      }
    }
    return this.commit(next, "evidence.recorded", input.sourceActor, {
      evidenceId,
      workItemId: item.id,
      kind: evidence.kind,
      result: evidence.result
    }, evidence);
  }

  private evaluationError(evaluation: GateEvaluation): CoreError {
    const code = evaluation.reasons[0] ?? (evaluation.result === "unknown" ? "EVIDENCE_UNKNOWN" : "RUN_NOT_COMPLETABLE");
    return error(code, "gate did not pass", {
      result: evaluation.result,
      missingEvidence: evaluation.missingEvidence,
      violatedObligations: evaluation.violatedObligations,
      staleEvidence: evaluation.staleEvidence,
      reasons: evaluation.reasons
    });
  }

  submitReview(input: SubmitReviewInput): CoreResult<GateDecision> {
    const state = this.state;
    if (!state) return this.reject(error("RUN_NOT_FOUND", "run does not exist"));
    const guard = this.guard(input) ?? this.mutable();
    if (guard) return this.reject(guard);
    if (!Number.isInteger(input.attempt) || !textValid(input.reviewerId) || !["pass", "fail", "unknown"].includes(String(input.result)) ||
        !Array.isArray(input.evidenceIds) || !input.evidenceIds.every(id => textValid(id, 1000))) {
      return this.reject(error("INVALID_INPUT", "review result, reviewer, attempt and evidenceIds are invalid"));
    }
    const item = state.workItems[input.workItemId];
    const mandate = state.mandates[input.mandateId];
    if (!item) return this.reject(error("ITEM_NOT_FOUND", "work item does not exist"));
    if (!mandate || mandate.workItemId !== item.id || item.currentMandateId !== mandate.id) {
      return this.reject(error("MANDATE_REQUIRED", "current mandate is required"));
    }
    if (!this.off("generation") && mandate.generation !== state.run.generation) {
      return this.reject(error("STALE_GENERATION", "review mandate belongs to an old generation"));
    }
    if (!this.off("actor") && (input.reviewerId !== mandate.reviewerId || input.reviewerId === mandate.workerId)) {
      return this.reject(error(input.reviewerId === mandate.workerId ? "REVIEWER_SAME_AS_WORKER" : "ACTOR_MISMATCH", "reviewer identity is not independent"));
    }
    if (!this.off("evidenceFreshness") && (input.attempt !== item.attempt || input.attempt !== mandate.attempt)) {
      return this.reject(error("MANDATE_STALE", "review attempt is not current"));
    }
    if (!this.off("anchor") && mandate.anchorVersion !== state.anchors[state.run.currentAnchorId].version &&
        (mandate.status === "superseded" || item.status === "superseded")) {
      return this.reject(error("ANCHOR_STALE", "review mandate belongs to a superseded anchor"));
    }
    if (!this.off("reviewState") && (item.status !== "reported_done" || mandate.status !== "reported_done")) {
      return this.reject(error("INVALID_TRANSITION", "review requires the same current mandate in reported_done state"));
    }
    const currentEvidence = Object.values(state.evidence).filter(entry =>
      entry.workItemId === item.id && entry.attempt === item.attempt &&
      entry.anchorVersion === mandate.anchorVersion && entry.generation === state.run.generation
    );
    if (!this.off("reviewerReadonly") && currentEvidence.some(entry =>
      entry.sourceActor === input.reviewerId && isMutationReceipt(entry.receipt)
    )) {
      return this.reject(error("REVIEWER_NOT_READONLY", "reviewer has a write receipt for this attempt"));
    }
    for (const id of input.evidenceIds) {
      const evidence = state.evidence[id];
      if (!evidence) return this.reject(error("EVIDENCE_MISSING", "review references unknown evidence: " + id));
      if (!this.off("evidenceFreshness") && (evidence.workItemId !== item.id || evidence.mandateId !== mandate.id)) {
        return this.reject(error("EVIDENCE_MISSING", "review references evidence from another work item or mandate: " + id));
      }
      if (!this.off("evidenceFreshness") &&
          (evidence.attempt !== item.attempt || evidence.anchorVersion !== mandate.anchorVersion || evidence.generation !== state.run.generation)) {
        return this.reject(error("EVIDENCE_STALE", "review references stale evidence: " + id));
      }
    }
    let evaluation: GateEvaluation | undefined;
    if (input.result === "pass") {
      if (input.evidenceIds.length === 0) return this.reject(error("EVIDENCE_MISSING", "pass review must cite evidence"));
      evaluation = this.evaluateOn(state, item.id, input.evidenceIds);
      if (evaluation.result !== "pass") return this.reject(this.evaluationError(evaluation));
    }
    const next = clone(state);
    const decisionId = this.drivers.createId("decision");
    const decision: GateDecision = {
      id: decisionId,
      workItemId: item.id,
      mandateId: mandate.id,
      attempt: item.attempt,
      anchorVersion: mandate.anchorVersion,
      generation: state.run.generation,
      reviewerId: input.reviewerId,
      result: input.result,
      evidenceIds: [...input.evidenceIds],
      reasons: evaluation?.reasons ?? [],
      createdAt: this.drivers.now(),
      invalidated: false
    };
    next.decisions[decisionId] = decision;
    next.workItems[item.id].status = input.result === "fail" ? "rework" : "verifying";
    next.mandates[mandate.id].status = input.result === "fail" ? "superseded" : "verifying";
    return this.commit(next, "review.submitted", input.reviewerId, {
      decisionId,
      workItemId: item.id,
      result: input.result,
      reasons: decision.reasons
    }, decision);
  }

  evaluateGate(workItemId: string): GateEvaluation {
    if (!this.state) {
      return { workItemId, attempt: 0, result: "unknown", missingEvidence: [], violatedObligations: [], staleEvidence: [], reasons: ["RUN_NOT_FOUND"] };
    }
    return this.evaluateOn(this.state, workItemId);
  }

  private evaluateOn(state: RunState, workItemId: string, citedIds?: string[]): GateEvaluation {
    const item = state.workItems[workItemId];
    if (!item) {
      return { workItemId, attempt: 0, result: "unknown", missingEvidence: [], violatedObligations: [], staleEvidence: [], reasons: ["ITEM_NOT_FOUND"] };
    }
    const anchor = state.anchors[state.run.currentAnchorId];
    const mandate = item.currentMandateId ? state.mandates[item.currentMandateId] : undefined;
    const allForItem = Object.values(state.evidence).filter(entry => entry.workItemId === item.id);
    const expectedAnchorVersion = mandate?.anchorVersion ?? anchor.version;
    const staleEvidence = allForItem.filter(entry =>
      entry.attempt !== item.attempt || entry.anchorVersion !== expectedAnchorVersion || entry.generation !== state.run.generation
    ).map(entry => entry.id);
    const current = allForItem.filter(entry => !staleEvidence.includes(entry.id));
    const cited = citedIds ? current.filter(entry => citedIds.includes(entry.id)) : current;
    const missingEvidence: string[] = [];
    const violatedObligations: string[] = [];
    const reasons: string[] = [];
    let failed = false;
    let unknown = false;
    const fail = (code: string) => { failed = true; reasons.push(code); };
    const markUnknown = (code: string) => { unknown = true; reasons.push(code); };

    if (!mandate) {
      markUnknown("MANDATE_REQUIRED");
    } else {
      if (!this.off("anchor") && mandate.anchorVersion !== anchor.version &&
          (mandate.status === "superseded" || item.status === "superseded")) fail("ANCHOR_STALE");
      if (!this.off("evidenceFreshness") && mandate.attempt !== item.attempt) fail("MANDATE_STALE");
      if (!this.off("generation") && mandate.generation !== state.run.generation) fail("STALE_GENERATION");
    }

    if (!this.off("dependency") && !item.dependencies.every(id => state.workItems[id]?.status === "accepted")) {
      fail("DEPENDENCY_NOT_ACCEPTED");
    }
    if (!this.off("reviewState") && current.some(entry => entry.kind === "user_feedback" && entry.result === "fail")) {
      fail("USER_REJECTED");
    }
    const linkedObligations = item.obligationIds.map(id => state.obligations[id]).filter(obligation =>
      obligation && anchor.obligationSnapshot.includes(obligation.id)
    );
    if (!this.off("prohibition")) {
      for (const obligationId of runProhibitionViolations(state)) {
        violatedObligations.push(obligationId);
        fail("PROHIBITION_VIOLATED");
      }
    }

    const required = new Set<EvidenceKind>();
    if (item.gateProfile === "code" || item.gateProfile === "visual") {
      required.add("build");
      required.add("unit");
      if (item.hostContractRequired) required.add("host_contract");
      if (item.gateProfile === "visual") required.add("runtime_gui");
    } else if (item.gateProfile === "deployment") {
      required.add("source_hash");
      required.add("build_hash");
      required.add("loaded_hash");
      required.add("host_receipt");
    } else if (item.gateProfile === "numeric_reconcile") {
      required.add("numeric_reconcile");
    }
    if (!this.off("evidence")) {
      for (const obligation of linkedObligations) {
        for (const kind of obligation.requiredEvidence ?? []) required.add(kind);
        if (obligation.animation && !this.off("animation")) required.add("animation");
        if (obligation.requiredEvidence?.includes("hover")) required.add("hover");
      }
      for (const kind of required) {
        const evidence = latestByKind(cited, kind);
        if (!evidence) {
          missingEvidence.push(kind);
          markUnknown(kind === "host_contract" ? "HOST_CONTRACT_UNKNOWN" : "EVIDENCE_MISSING");
          continue;
        }
        if (evidence.result === "fail") fail("EVIDENCE_FAIL");
        else if (evidence.result === "unknown") markUnknown("EVIDENCE_UNKNOWN");
        if (!this.off("actor") && mandate) {
          const fromReviewer = evidence.sourceActor === mandate.reviewerId && evidence.sourceRole === "reviewer";
          const fromObservedHost = evidence.sourceRole === "host" && evidence.receipt.hostObserved === true;
          if (!fromReviewer && !fromObservedHost) fail("ACTOR_MISMATCH");
        }
        if (kind === "build") {
          const exitCode = receiptNumber(evidence, "exitCode");
          if (exitCode === undefined) markUnknown("EVIDENCE_UNKNOWN");
          else if (exitCode !== 0) fail("EVIDENCE_FAIL");
        }
        if (kind === "unit") {
          const passed = receiptNumber(evidence, "passed");
          const failedUnits = receiptNumber(evidence, "failed");
          const total = receiptNumber(evidence, "total");
          if (passed === undefined || failedUnits === undefined || !Number.isInteger(passed) || !Number.isInteger(failedUnits) || passed < 0 || failedUnits < 0) {
            markUnknown("EVIDENCE_UNKNOWN");
          } else if (failedUnits !== 0 || (total !== undefined && total !== passed + failedUnits)) {
            fail("EVIDENCE_FAIL");
          } else if (evidence.result === "pass" && passed === 0) {
            markUnknown("EVIDENCE_UNKNOWN");
          }
        }
        if (kind === "host_contract" && !this.off("hostProjection")) {
          const activity = receiptNumber(evidence, "activityCount") ?? 0;
          if (activity > 0 && receiptString(evidence, "emptyReason") === "no_activity") fail("HOST_CONTRACT_UNKNOWN");
        }
      }
    }

    if (!this.off("animation")) {
      for (const obligation of linkedObligations.filter(entry => entry.animation && entry.status !== "waived")) {
        const evidence = latestByKind(cited, "animation");
        if (!evidence) {
          if (!missingEvidence.includes("animation")) missingEvidence.push("animation");
          markUnknown("OBLIGATION_OPEN");
        } else if (receiptString(evidence, "mode") !== obligation.animation || receiptString(evidence, "obligationId") !== obligation.id) {
          fail("OBLIGATION_OPEN");
        }
      }
    }

    if (item.gateProfile === "deployment" && !this.off("evidence")) {
      const source = latestByKind(cited, "source_hash");
      const build = latestByKind(cited, "build_hash");
      const loaded = latestByKind(cited, "loaded_hash");
      const host = latestByKind(cited, "host_receipt");
      if (!this.off("deploymentHash") && source?.result === "pass" && build?.result === "pass" && loaded?.result === "pass") {
        const sourceHash = receiptString(source, "hash");
        const buildHash = receiptString(build, "hash");
        const loadedHash = receiptString(loaded, "hash");
        if (!sourceHash || !buildHash || sourceHash !== buildHash) fail("SOURCE_ARTIFACT_MISMATCH");
        if (!loadedHash || loadedHash !== buildHash) fail("RUNTIME_HASH_MISMATCH");
      }
      if (host && !this.off("hostReceipt")) {
        const application = receiptString(host, "application");
        const restartReason = receiptString(host, "restartReason");
        if (application === "restart-required" || restartReason === "unmanaged-plugin" || restartReason === "unmanaged") {
          fail("RESTART_REQUIRED");
        } else if (host.result === "pass" && application !== "applied" && application !== "loaded" && host.receipt.deployed !== true) {
          markUnknown("HOST_CONTRACT_UNKNOWN");
        }
      }
    }

    if (item.gateProfile === "numeric_reconcile" && !this.off("evidence")) {
      const numeric = latestByKind(cited, "numeric_reconcile");
      if (numeric) {
        const left = receiptNumber(numeric, "leftValue");
        const right = receiptNumber(numeric, "rightValue");
        const leftScope = receiptString(numeric, "leftScope");
        const rightScope = receiptString(numeric, "rightScope");
        if (left === undefined || right === undefined || !leftScope || !rightScope) {
          markUnknown("EVIDENCE_UNKNOWN");
        } else if (leftScope !== rightScope) {
          markUnknown("EVIDENCE_UNKNOWN");
        } else if (left !== right) {
          fail("EVIDENCE_FAIL");
        }
        const declaredDelta = receiptNumber(numeric, "delta");
        if (declaredDelta !== undefined && left !== undefined && right !== undefined && declaredDelta !== right - left) {
          fail("EVIDENCE_FAIL");
        }
      }
    }

    if (item.gateProfile === "coverage" && !this.off("coverage")) {
      for (const obligation of linkedObligations.filter(entry => entry.kind === "coverage")) {
        if (obligation.status === "waived") continue;
        const candidates = cited.filter(entry => entry.kind === "coverage" && coverageMatches(entry, obligation));
        const evidence = candidates[candidates.length - 1];
        if (!evidence) {
          missingEvidence.push("coverage:" + obligation.id);
          markUnknown("COVERAGE_INCOMPLETE");
          continue;
        }
        const coverage = receiptString(evidence, "coverage");
        if (evidence.result === "fail" || coverage === "partial" || coverage === "substitute") fail("COVERAGE_INCOMPLETE");
        else if (evidence.result === "unknown" || coverage === "unknown" || coverage !== "full") markUnknown("COVERAGE_INCOMPLETE");
      }
    }

    return {
      workItemId,
      attempt: item.attempt,
      result: failed ? "fail" : unknown ? "unknown" : "pass",
      missingEvidence: unique(missingEvidence),
      violatedObligations: unique(violatedObligations),
      staleEvidence: unique(staleEvidence),
      reasons: unique(reasons)
    };
  }

  releaseWorkItem(input: ReleaseWorkItemInput): CoreResult<WorkItem> {
    const state = this.state;
    if (!state) return this.reject(error("RUN_NOT_FOUND", "run does not exist"));
    const guard = this.guard(input) ?? this.mutable();
    if (guard) return this.reject(guard);
    const item = state.workItems[input.workItemId];
    if (!item) return this.reject(error("ITEM_NOT_FOUND", "work item does not exist"));
    const mandate = item.currentMandateId ? state.mandates[item.currentMandateId] : undefined;
    if (!mandate) return this.reject(error("MANDATE_REQUIRED", "release requires current mandate"));
    if (!this.off("actor") && (input.reviewerId !== mandate.reviewerId || input.reviewerId === mandate.workerId)) {
      return this.reject(error("ACTOR_MISMATCH", "release reviewer is not the independent mandate reviewer"));
    }
    if (!this.off("reviewState") && (item.status !== "verifying" || mandate.status !== "verifying")) {
      return this.reject(error("INVALID_TRANSITION", "release requires the same current mandate in verifying state"));
    }
    if (!this.off("generation") && mandate.generation !== state.run.generation) {
      return this.reject(error("STALE_GENERATION", "release mandate belongs to an old generation"));
    }
    const decisions = Object.values(state.decisions).filter(decision =>
      decision.workItemId === item.id && decision.mandateId === mandate.id &&
      decision.reviewerId === input.reviewerId && !decision.invalidated
    );
    const decision = decisions[decisions.length - 1];
    if (!decision || decision.result !== "pass") return this.reject(error("EVIDENCE_MISSING", "release requires a passing review decision"));
    if (!this.off("evidenceFreshness") &&
        (decision.attempt !== item.attempt || decision.anchorVersion !== mandate.anchorVersion || decision.generation !== state.run.generation)) {
      return this.reject(error("EVIDENCE_STALE", "passing decision is stale"));
    }
    if (!this.off("reviewState") && !hasWorkerDoneProof(state, mandate)) {
      return this.reject(error("INVALID_TRANSITION", "release lacks the current worker reported_done audit precursor"));
    }
    const reviewerWrite = Object.values(state.evidence).some(entry =>
      entry.workItemId === item.id && entry.attempt === item.attempt &&
      entry.anchorVersion === mandate.anchorVersion && entry.generation === state.run.generation &&
      entry.sourceActor === input.reviewerId && isMutationReceipt(entry.receipt)
    );
    if (!this.off("reviewerReadonly") && reviewerWrite) {
      return this.reject(error("REVIEWER_NOT_READONLY", "reviewer write receipt invalidates release"));
    }
    const evaluation = this.evaluateOn(state, item.id);
    if (evaluation.result !== "pass") return this.reject(this.evaluationError(evaluation));
    const next = clone(state);
    const accepted = next.workItems[item.id];
    accepted.status = "accepted";
    next.mandates[mandate.id].status = "accepted";
    const currentEvidence = Object.values(next.evidence).filter(entry =>
      entry.workItemId === item.id && entry.attempt === item.attempt &&
      entry.anchorVersion === decision.anchorVersion && entry.generation === next.run.generation
    );
    for (const obligationId of accepted.obligationIds) {
      const obligation = next.obligations[obligationId];
      if (!obligation || obligation.status === "waived" || obligation.status === "superseded") continue;
      if (obligation.kind === "coverage") {
        const full = currentEvidence.some(entry => entry.kind === "coverage" && entry.result === "pass" &&
          receiptString(entry, "coverage") === "full" && coverageMatches(entry, obligation));
        if (full || this.off("coverage")) obligation.status = "met";
      } else {
        obligation.status = "met";
      }
      obligation.evidenceIds = unique([...obligation.evidenceIds, ...currentEvidence.filter(entry => entry.result === "pass").map(entry => entry.id)]);
    }
    for (const successor of Object.values(next.workItems)) {
      if (successor.status === "held" && successor.dependencies.includes(item.id) &&
          successor.dependencies.every(id => next.workItems[id]?.status === "accepted")) {
        successor.status = "ready";
      }
    }
    return this.commit(next, "work.released", input.reviewerId, {
      workItemId: item.id,
      decisionId: decision.id,
      unlockedItemIds: Object.values(next.workItems).filter(entry => entry.status === "ready" && entry.dependencies.includes(item.id)).map(entry => entry.id)
    }, accepted);
  }

  recordUserFeedback(input: RecordUserFeedbackInput): CoreResult<WorkItem> {
    const state = this.state;
    if (!state) return this.reject(error("RUN_NOT_FOUND", "run does not exist"));
    const guard = this.guard(input) ?? this.mutable();
    if (guard) return this.reject(guard);
    if (!["accepted", "rejected"].includes(String(input.verdict)) ||
        (input.note !== undefined && !textValid(input.note))) {
      return this.reject(error("INVALID_INPUT", "feedback verdict or note is invalid"));
    }
    const item = state.workItems[input.workItemId];
    if (!item) return this.reject(error("ITEM_NOT_FOUND", "work item does not exist"));
    if (input.instructionId !== undefined && !textValid(input.instructionId, 1000)) {
      return this.reject(error("INVALID_TRANSITION", "instructionId must be bounded non-empty text"));
    }
    const originalMandate = item.currentMandateId ? state.mandates[item.currentMandateId] : undefined;
    if (input.verdict === "rejected" && originalMandate && item.status !== "accepted" &&
        !this.off("generation") && originalMandate.generation !== state.run.generation) {
      return this.reject(error("STALE_GENERATION", "feedback mandate belongs to an old generation"));
    }
    const next = clone(state);
    const nextItem = next.workItems[item.id];
    if (input.verdict === "accepted") {
      return this.commit(next, "feedback.accepted", "user", { workItemId: item.id, instructionId: input.instructionId ?? null }, nextItem);
    }
    const fingerprint = input.fingerprint ?? input.note ?? "";
    if (!textValid(fingerprint)) return this.reject(error("INVALID_TRANSITION", "rejected feedback requires a failure fingerprint"));
    for (const decision of Object.values(next.decisions)) {
      if (decision.workItemId === item.id && decision.attempt === nextItem.attempt) decision.invalidated = true;
    }
    const evidenceId = this.drivers.createId("evidence");
    const mandate = nextItem.currentMandateId ? next.mandates[nextItem.currentMandateId] : undefined;
    if (mandate) {
      mandate.needsStop = mandate.status === "running";
      mandate.status = "superseded";
      next.evidence[evidenceId] = {
        id: evidenceId,
        workItemId: item.id,
        mandateId: mandate.id,
        attempt: nextItem.attempt,
        anchorVersion: mandate.anchorVersion,
        generation: mandate.generation,
        kind: "user_feedback",
        result: "fail",
        sourceActor: "user",
        sourceRole: "user",
        receipt: { fingerprint, rejected: true },
        summary: input.note ?? "",
        createdAt: this.drivers.now()
      };
    }
    nextItem.failureFingerprints[fingerprint] = (nextItem.failureFingerprints[fingerprint] ?? 0) + 1;
    const repeated = nextItem.failureFingerprints[fingerprint] >= next.run.gatePolicy.maxSameFingerprint;
    if (!this.off("failureBudget") && (repeated || nextItem.attempt >= next.run.gatePolicy.maxAttempts)) {
      nextItem.status = "blocked";
      next.run.status = "blocked";
    } else {
      nextItem.status = "rework";
      next.run.status = "active";
    }
    const revoked = new Set<string>([item.id]);
    if (!this.off("dependency")) {
      let expanded = true;
      while (expanded) {
        expanded = false;
        for (const successor of Object.values(next.workItems)) {
          if (!revoked.has(successor.id) && successor.dependencies.some(id => revoked.has(id))) {
            revoked.add(successor.id);
            expanded = true;
          }
        }
      }
    }
    const affectedObligations = new Set<string>();
    for (const revokedId of revoked) {
      const revokedItem = next.workItems[revokedId];
      if (revokedId !== item.id) revokedItem.status = "superseded";
      for (const obligationId of revokedItem.obligationIds) affectedObligations.add(obligationId);
      for (const decision of Object.values(next.decisions)) {
        if (decision.workItemId === revokedId) decision.invalidated = true;
      }
      for (const affectedMandate of Object.values(next.mandates)) {
        if (affectedMandate.workItemId === revokedId && affectedMandate.status !== "superseded") {
          affectedMandate.needsStop = affectedMandate.status === "running";
          affectedMandate.status = "superseded";
        }
      }
    }
    for (const obligationId of affectedObligations) {
      const obligation = next.obligations[obligationId];
      if (obligation?.status === "met") obligation.status = "open";
    }
    return this.commit(next, "feedback.rejected", "user", {
      workItemId: item.id,
      fingerprint,
      count: nextItem.failureFingerprints[fingerprint],
      status: nextItem.status,
      affectedWorkItemIds: [...revoked],
      reopenedObligationIds: [...affectedObligations]
    }, nextItem);
  }

  completeRun(input: WriteGuard): CoreResult<RunState["run"]> {
    const state = this.state;
    if (!state) return this.reject(error("RUN_NOT_FOUND", "run does not exist"));
    const guard = this.guard(input);
    if (guard) return this.reject(guard);
    if (state.run.status !== "active") return this.reject(error("RUN_NOT_COMPLETABLE", "only active run can complete"));
    const anchor = state.anchors[state.run.currentAnchorId];
    const active = anchor.obligationSnapshot.map(id => state.obligations[id]);
    if (!this.off("completion")) {
      const prohibitionViolations = this.off("prohibition") ? [] : runProhibitionViolations(state);
      if (prohibitionViolations.length > 0) {
        return this.reject(error("PROHIBITION_VIOLATED", "run-level prohibition violation blocks completion", { obligationIds: prohibitionViolations }));
      }
      const incompleteCoverage = active.filter(obligation => obligation.kind === "coverage" && obligation.status !== "met" && obligation.status !== "waived");
      if (!this.off("coverage") && incompleteCoverage.length > 0) {
        return this.reject(error("COVERAGE_INCOMPLETE", "mandatory coverage is incomplete", { obligationIds: incompleteCoverage.map(entry => entry.id) }));
      }
      const open = active.filter(obligation => obligation.status !== "met" && obligation.status !== "waived" &&
        (obligation.kind !== "coverage" || !this.off("coverage")));
      if (open.length > 0) return this.reject(error("OPEN_OBLIGATIONS", "unwaived obligations remain open", { obligationIds: open.map(entry => entry.id) }));
      const unaccepted = Object.values(state.workItems).filter(item => item.mandatory && item.status !== "accepted");
      if (unaccepted.length > 0) return this.reject(error("UNACCEPTED_ITEMS", "mandatory work items are not accepted", { itemIds: unaccepted.map(entry => entry.id) }));
      for (const item of Object.values(state.workItems).filter(entry => entry.mandatory)) {
        const mandate = item.currentMandateId ? state.mandates[item.currentMandateId] : undefined;
        const historical = item.status === "accepted" && mandate && mandate.generation !== state.run.generation;
        const evaluationState = historical && mandate ? clone(state) : state;
        if (historical && mandate) evaluationState.run.generation = mandate.generation;
        const evaluation = this.evaluateOn(evaluationState, item.id);
        if (evaluation.result === "unknown") return this.reject(error("GATE_UNKNOWN", "a mandatory item gate remains unknown", { itemId: item.id }));
        if (evaluation.result === "fail") return this.reject(error("RUN_NOT_COMPLETABLE", "a mandatory item gate fails", { itemId: item.id }));
      }
    }
    const next = clone(state);
    next.run.status = "completed";
    return this.commit(next, "run.completed", "lead", {}, next.run);
  }

  pauseRun(input: WriteGuard): CoreResult<RunState["run"]> {
    const state = this.state;
    if (!state) return this.reject(error("RUN_NOT_FOUND", "run does not exist"));
    const guard = this.guard(input);
    if (guard) return this.reject(guard);
    if (state.run.status !== "active" && state.run.status !== "blocked" && state.run.status !== "needs_user") {
      return this.reject(error("INVALID_TRANSITION", "run cannot be paused from " + state.run.status));
    }
    const next = clone(state);
    next.run.status = "paused";
    return this.commit(next, "run.paused", "user", {}, next.run);
  }

  resumeRun(input: WriteGuard): CoreResult<RunState["run"]> {
    const state = this.state;
    if (!state) return this.reject(error("RUN_NOT_FOUND", "run does not exist"));
    const guard = this.guard(input);
    if (guard) return this.reject(guard);
    if (state.run.status !== "paused") return this.reject(error("INVALID_TRANSITION", "only paused run can resume"));
    const next = clone(state);
    next.run.status = "active";
    return this.commit(next, "run.resumed", "user", {}, next.run);
  }

  reconcileRecovery(input: ReconcileRecoveryInput): CoreResult<RunState["run"] & RecoveryResult> {
    const state = this.state;
    if (!state) return this.reject(error("RUN_NOT_FOUND", "run does not exist"));
    const guard = this.guard(input);
    if (guard) return this.reject(guard);
    if (state.run.status === "completed") return this.reject(error("INVALID_TRANSITION", "completed run cannot recover"));
    if (!Array.isArray(input.nativeReceipts) || input.nativeReceipts.some(receipt => !isRecord(receipt) ||
        !textValid(receipt.mandateId, 1000) || !["running", "reported_done", "unknown", "failed"].includes(String(receipt.status)))) {
      return this.reject(error("INVALID_INPUT", "nativeReceipts must be an array of valid recovery receipts"));
    }
    const next = clone(state);
    next.run.generation += 1;
    const receipts = new Map<string, NativeRecoveryReceipt>(input.nativeReceipts.map(receipt => [receipt.mandateId, receipt]));
    const unknownMandateIds: string[] = [];
    const nativeReportedDoneMandateIds: string[] = [];
    for (const mandate of Object.values(next.mandates)) {
      if (mandate.status !== "running") continue;
      const receipt = receipts.get(mandate.id);
      const item = next.workItems[mandate.workItemId];
      if (!receipt || receipt.status === "unknown" || receipt.status === "failed") {
        mandate.status = "unknown";
        mandate.needsStop = false;
        item.status = "verifying";
        unknownMandateIds.push(mandate.id);
      } else if (receipt.status === "reported_done") {
        const recovery = this.createRecoveryReviewMandate(next, mandate);
        nativeReportedDoneMandateIds.push(recovery.id);
      }
    }
    if (next.run.status === "paused") next.run.status = "active";
    const value = { ...next.run, unknownMandateIds };
    return this.commit(next, "run.recovered", "host", {
      previousGeneration: state.run.generation,
      generation: next.run.generation,
      unknownMandateIds,
      nativeReportedDoneMandateIds
    }, value);
  }
}
