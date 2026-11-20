import type {
  Anchor,
  AuditEvent,
  Evidence,
  GateDecision,
  GateEvaluation,
  Mandate,
  ModelRoute,
  Obligation,
  RouteFailure,
  Run,
  WorkItem,
} from "../core/types.ts";

export interface ProjectionRequestDto {
  /** Exact native root SessionId; display names and subagent aliases are not accepted. */
  sessionId: string;
}

export interface NativeTaskDto {
  id: string;
  revision: number;
  status: "pending" | "in_progress" | "completed" | "deleted";
  subject: string;
  description?: string;
  ownerId?: string;
  ownerName?: string;
  blockedBy: string[];
  writeScopes: string[];
  ready: boolean;
  writeScopeWarnings: string[];
}

export interface NativeMemberDto {
  /** Native SessionId, never a display-name alias. */
  id: string;
  name: string;
  /** Running/inactive describe residency only, never task success. */
  status: string;
  activity?: "running" | "inactive";
  mode?: string;
  /** Real live model.current() projection; absent for cold/diagnostic members. */
  modelRoute?: ModelRoute | null;
  diagnostic?: string;
}

export interface GoalDto {
  id: string;
  revision: number;
  objective: string;
  phase: "active" | "paused" | "blocked" | "complete";
  roundsStarted: number;
  maxGoalRounds: number;
  activation: "armed" | "disarmed";
}

export interface AgentTeamDto {
  enabled: boolean;
  tasks: NativeTaskDto[];
}

export interface RecoveryDto {
  status: "not_required" | "ready" | "unavailable";
  reason?: string;
}

export interface RouteInspectionDto {
  mandateId: string;
  targetRole: "worker" | "reviewer";
  nativeAgentId: string;
  expectedRoute: ModelRoute | null;
  currentRoute: ModelRoute | null;
  lastRequestRoute: ModelRoute | null;
  status: "matched" | "mismatch" | "inherited" | "unknown";
  reason?: string;
}

export interface SnapshotProofDto {
  status: "verified" | "invalid" | "unavailable";
  runId?: string;
  snapshotSha256?: string;
  revision?: number;
  generation?: number;
  nativeEventSeq?: number;
  reason?: string;
}

/** Complete current-root DTO. No field is populated from demo or model-authored native state. */
export interface SuperProjectionDto {
  schemaVersion: 1;
  sessionId: string;
  agentPreset: "super-agent";
  run: Run | null;
  currentAnchor: Anchor | null;
  anchors: Anchor[];
  obligations: Obligation[];
  openObligations: Obligation[];
  workItems: WorkItem[];
  mandates: Mandate[];
  /** Wire-v1 optional extension; no policy/failure records means no fabricated route data. */
  routeFailures?: RouteFailure[];
  evidence: Evidence[];
  decisions: GateDecision[];
  audit: AuditEvent[];
  gates: GateEvaluation[];
  teamEnabled: boolean;
  agentTeam: AgentTeamDto;
  goal: GoalDto | null;
  subagentCatalog: NativeMemberDto[];
  blockReasons: string[];
  recovery: RecoveryDto;
  /** Optional wire-v1 extension; Host reports only actual native readback, never a self-asserted digest. */
  proof?: SnapshotProofDto;
  observedAt: string;
}
