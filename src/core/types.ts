export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type RunStatus = "active" | "paused" | "blocked" | "needs_user" | "completed";
export type ObligationKind = "requirement" | "prohibition" | "coverage";
export type ObligationStatus = "open" | "met" | "violated" | "waived" | "superseded";
export type CoverageStatus = "full" | "partial" | "substitute" | "unknown";
export type WorkItemStatus =
  | "held"
  | "ready"
  | "mandated"
  | "running"
  | "reported_done"
  | "verifying"
  | "rework"
  | "accepted"
  | "blocked"
  | "superseded";
export type MandateStatus =
  | "prepared"
  | "running"
  | "reported_done"
  | "verifying"
  | "accepted"
  | "superseded"
  | "unknown";
export type EvidenceResult = "pass" | "fail" | "unknown";
export type SourceRole = "worker" | "reviewer" | "lead" | "host" | "user";
export type GateProfile = "code" | "visual" | "deployment" | "numeric_reconcile" | "coverage";
export type ModelPolicyMode = "locked" | "balanced" | "economy" | "performance";
export type ModelFailureKind = "transient" | "timeout" | "rate_limit" | "quota" | "account_quota" | "provider_unavailable" | "route_incompatible" | "authentication" | "permission" | "tool_input" | "business_acceptance" | "snapshot_proof" | "write_scope" | "identity" | "unknown";
export type RouteSwitchStatus = "requested" | "rejected" | "exhausted";

export interface ModelRoute {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface ModelPolicy {
  mode: ModelPolicyMode;
  allowedRoutes: ModelRoute[];
  workerRoute?: ModelRoute | null;
  reviewerRoute?: ModelRoute | null;
  allowFailureSwitch: boolean;
  maxSameRouteRetries: number;
  maxRouteSwitches: number;
  cooldownMs?: number;
  revision: number;
}

export interface RouteFailure {
  id: string;
  mandateId: string;
  route: ModelRoute | null;
  failureKind: ModelFailureKind;
  failureCode: string;
  action: "rejected" | "retry_recorded" | "switch_required";
  sameRouteRetries: number;
  routeSwitches: number;
  createdAt: string;
}

export interface RouteSwitch {
  id: string;
  mandateId: string;
  from: ModelRoute | null;
  to: ModelRoute | null;
  failureCode: string;
  status: RouteSwitchStatus;
  reason: string;
  attempt: number;
  generation: number;
  actor: string;
  createdAt: string;
}

export type EvidenceKind =
  | "build"
  | "unit"
  | "static"
  | "simulated"
  | "host_contract"
  | "runtime_gui"
  | "animation"
  | "hover"
  | "artifact"
  | "source_hash"
  | "build_hash"
  | "loaded_hash"
  | "host_receipt"
  | "numeric_reconcile"
  | "coverage"
  | "user_feedback";

export type HardCheck =
  | "revision"
  | "generation"
  | "anchor"
  | "dependency"
  | "writeScope"
  | "actor"
  | "reviewerReadonly"
  | "evidence"
  | "evidenceFreshness"
  | "prohibition"
  | "animation"
  | "deploymentHash"
  | "hostReceipt"
  | "failureBudget"
  | "coverage"
  | "completion"
  | "hostProjection"
  | "reviewState"
  | "restore"
  | "receipt"
  | "input"
  | "proof"
  | "routing";

export interface GatePolicy {
  maxAttempts: number;
  maxSameFingerprint: number;
}

export interface GatePolicyInput {
  maxAttempts?: number;
  maxSameFingerprint?: number;
}

export interface ObligationInput {
  id: string;
  kind: ObligationKind;
  text: string;
  requiredEvidence?: EvidenceKind[];
  animation?: string;
  coverage?: CoverageStatus;
  sourceId?: string;
  verification?: "mandate_delivery";
}

export interface Obligation extends ObligationInput {
  status: ObligationStatus;
  evidenceIds: string[];
  userWaiver?: string;
}

export interface Anchor {
  id: string;
  version: number;
  supersedes?: string;
  supersededBy?: string;
  latestInstruction: string;
  definitionOfDone: string;
  constraints: string[];
  obligationSnapshot: string[];
  createdAt: string;
}

export interface Run {
  id: string;
  sessionId: string;
  objective: string;
  definitionOfDone: string;
  status: RunStatus;
  currentAnchorId: string;
  revision: number;
  generation: number;
  gatePolicy: GatePolicy;
  /** Null means no configured policy; Host accepts legacy v2 absence and normalizes it at the storage boundary. */
  modelPolicy: ModelPolicy | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkItem {
  id: string;
  nativeTaskId?: string;
  title: string;
  writeScopes: string[];
  dependencies: string[];
  acceptance: string[];
  obligationIds: string[];
  gateProfile: GateProfile;
  hostContractRequired: boolean;
  mandatory: boolean;
  status: WorkItemStatus;
  attempt: number;
  failureFingerprints: Record<string, number>;
  currentMandateId?: string;
}

export interface Mandate {
  id: string;
  workItemId: string;
  anchorVersion: number;
  generation: number;
  attempt: number;
  workerId: string;
  reviewerId: string;
  writeScopes: string[];
  acceptance: string[];
  knownFailures: string[];
  status: MandateStatus;
  nativeTaskId?: string;
  workerAgentId?: string;
  reviewerAgentId?: string;
  needsStop: boolean;
  mandateText: string;
  workerRoute?: ModelRoute | null;
  reviewerRoute?: ModelRoute | null;
  routeReason?: string;
  policyRevision?: number;
  routeSwitches?: RouteSwitch[];
}

export interface Evidence {
  id: string;
  workItemId: string;
  mandateId: string;
  attempt: number;
  anchorVersion: number;
  generation: number;
  kind: EvidenceKind;
  result: EvidenceResult;
  sourceActor: string;
  sourceRole: SourceRole;
  receipt: Record<string, JsonValue>;
  summary: string;
  createdAt: string;
}

export interface GateDecision {
  id: string;
  workItemId: string;
  mandateId: string;
  attempt: number;
  anchorVersion: number;
  generation: number;
  reviewerId: string;
  result: EvidenceResult;
  evidenceIds: string[];
  reasons: string[];
  createdAt: string;
  invalidated: boolean;
}

export interface StateChanges {
  run?: Run;
  anchors?: Record<string, Anchor | null>;
  obligations?: Record<string, Obligation | null>;
  workItems?: Record<string, WorkItem | null>;
  mandates?: Record<string, Mandate | null>;
  evidence?: Record<string, Evidence | null>;
  decisions?: Record<string, GateDecision | null>;
  routeFailures?: Record<string, RouteFailure | null>;
}

export interface AuditEvent {
  id: string;
  runId: string;
  revision: number;
  generation: number;
  type: string;
  payload: Record<string, JsonValue>;
  changes: StateChanges;
  actor: string;
  timestamp: string;
}

export interface RunState {
  schemaVersion: 2;
  run: Run;
  anchors: Record<string, Anchor>;
  obligations: Record<string, Obligation>;
  workItems: Record<string, WorkItem>;
  mandates: Record<string, Mandate>;
  routeFailures: Record<string, RouteFailure>;
  evidence: Record<string, Evidence>;
  decisions: Record<string, GateDecision>;
  audit: AuditEvent[];
}

export interface CoreError {
  code: string;
  message: string;
  details?: Record<string, JsonValue>;
}

export type CoreResult<T> =
  | { ok: true; state: RunState; value: T; events: AuditEvent[] }
  | { ok: false; state: RunState | null; error: CoreError; events: [] };

export interface WriteGuard {
  expectedRevision: number;
  expectedGeneration: number;
}

export interface CreateRunInput {
  sessionId: string;
  objective: string;
  definitionOfDone: string;
  obligations: ObligationInput[];
  gatePolicy?: GatePolicyInput;
}

export type ObligationDelta =
  | { op: "add"; obligation: ObligationInput }
  | { op: "amend"; id: string; patch: Partial<Omit<ObligationInput, "id">> }
  | { op: "waive"; id: string; reason: string }
  | { op: "supersede"; id: string; replacement: ObligationInput };

export interface ApplyUserInstructionInput extends WriteGuard {
  runId: string;
  instruction: string;
  obligationDelta: ObligationDelta[];
  /** Full replacement contracts explicitly approved by the user; replanning still requires a fresh attempt and review. */
  workItemRevisions?: WorkItemInput[];
}

export interface WorkItemInput {
  id: string;
  title: string;
  dependencies: string[];
  writeScopes: string[];
  acceptance: string[];
  obligationIds: string[];
  gateProfile: GateProfile;
  hostContractRequired?: boolean;
  mandatory?: boolean;
}

export interface PlanWorkItemsInput extends WriteGuard {
  items: WorkItemInput[];
}

export interface PrepareMandateInput extends WriteGuard {
  workItemId: string;
  workerId: string;
  reviewerId: string;
  knownFailures: string[];
  routeReason?: string;
}

export interface BindExecutionInput extends WriteGuard {
  mandateId: string;
  nativeTaskId?: string;
  workerAgentId?: string;
}

export interface BindReviewerInput extends WriteGuard {
  mandateId: string;
  reviewerAgentId: string;
}

export interface ReportWorkerDoneInput extends WriteGuard {
  mandateId: string;
  workerId: string;
  summary: string;
}

export interface RecordEvidenceInput extends WriteGuard {
  workItemId: string;
  mandateId: string;
  attempt: number;
  kind: EvidenceKind;
  result: EvidenceResult;
  sourceActor: string;
  sourceRole: SourceRole;
  receipt: Record<string, JsonValue>;
  summary?: string;
}

export interface SubmitReviewInput extends WriteGuard {
  workItemId: string;
  mandateId: string;
  attempt: number;
  reviewerId: string;
  result: EvidenceResult;
  evidenceIds: string[];
}

export interface ReleaseWorkItemInput extends WriteGuard {
  workItemId: string;
  reviewerId: string;
}

export interface RecordUserFeedbackInput extends WriteGuard {
  workItemId: string;
  instructionId?: string;
  verdict: "accepted" | "rejected";
  note?: string;
  fingerprint?: string;
}

export interface NativeRecoveryReceipt {
  mandateId: string;
  status: "running" | "reported_done" | "unknown" | "failed";
}

export interface ReconcileRecoveryInput extends WriteGuard {
  nativeReceipts: NativeRecoveryReceipt[];
}

export interface RecoveryResult {
  generation: number;
  unknownMandateIds: string[];
}

export interface GateEvaluation {
  workItemId: string;
  attempt: number;
  result: EvidenceResult;
  missingEvidence: string[];
  violatedObligations: string[];
  staleEvidence: string[];
  reasons: string[];
}

export interface SetModelPolicyInput extends WriteGuard {
  policy: Omit<ModelPolicy, "revision">;
}

export interface RecordRouteFailureInput extends WriteGuard {
  mandateId: string;
  targetRole?: "worker" | "reviewer";
  failureKind: ModelFailureKind;
  failureCode: string;
  retrySameRoute?: boolean;
}

export interface SwitchMandateRouteInput extends WriteGuard {
  mandateId: string;
  targetRole: "worker" | "reviewer";
  to: ModelRoute;
  failureCode: string;
  reason: string;
}

export interface SnapshotProof {
  runId: string;
  snapshotSha256: string;
  revision: number;
  generation: number;
  nativeEventSeq: number;
}

export interface CoreDrivers {
  createId: (kind: string) => string;
  now: () => string;
  digestSnapshot: (snapshot: unknown) => string;
}
