/**
 * Client-local bridge for the host projection.
 *
 * The host owns src/shared/types.ts. This module deliberately repeats only the
 * wire shape it consumes and validates every runtime value; no host import or
 * fixture is used as a production data source.
 */

export type EvidenceResult = 'pass' | 'fail' | 'unknown'
export type RunStatus = 'draft' | 'active' | 'paused' | 'blocked' | 'needs_user' | 'completed'
export type WorkItemStatus =
  | 'held' | 'ready' | 'mandated' | 'running' | 'reported_done' | 'verifying'
  | 'rework' | 'accepted' | 'blocked' | 'superseded'

export type ModelPolicyMode = 'locked' | 'balanced' | 'economy' | 'performance'
export type ModelFailureKind =
  | 'transient' | 'timeout' | 'rate_limit' | 'quota' | 'account_quota'
  | 'provider_unavailable' | 'route_incompatible' | 'authentication' | 'permission'
  | 'tool_input' | 'business_acceptance' | 'snapshot_proof' | 'write_scope' | 'identity' | 'unknown'

export interface ModelRouteDto {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface ModelPolicyDto {
  mode: ModelPolicyMode
  allowedRoutes: ModelRouteDto[]
  workerRoute?: ModelRouteDto
  reviewerRoute?: ModelRouteDto
  allowFailureSwitch: boolean
  maxSameRouteRetries: number
  maxRouteSwitches: number
  cooldownMs?: number
  revision: number
}

export interface RouteFailureDto {
  id: string
  mandateId: string
  route: ModelRouteDto | null
  failureKind: ModelFailureKind
  failureCode: string
  action: 'rejected' | 'retry_recorded' | 'switch_required'
  sameRouteRetries: number
  routeSwitches: number
  createdAt: string
}

export interface RouteSwitchDto {
  id: string
  mandateId: string
  from: ModelRouteDto | null
  to: ModelRouteDto | null
  failureCode: string
  status: 'requested' | 'rejected' | 'exhausted'
  reason: string
  attempt: number
  generation: number
  actor: string
  createdAt: string
}

export interface RunDto {
  id: string
  sessionId: string
  objective: string
  definitionOfDone: string
  status: RunStatus
  currentAnchorId: string
  revision: number
  generation: number
  modelPolicy?: ModelPolicyDto
  createdAt: string
  updatedAt: string
}

export interface AnchorDto {
  id: string
  version: number
  supersedes?: string
  supersededBy?: string
  latestInstruction: string
  definitionOfDone: string
  constraints: string[]
  obligationSnapshot: string[]
  createdAt: string
}

export interface ObligationDto {
  id: string
  kind: 'requirement' | 'prohibition' | 'coverage'
  text: string
  status: 'open' | 'met' | 'violated' | 'waived' | 'superseded'
  evidenceIds: string[]
  requiredEvidence?: string[]
  coverage?: 'full' | 'partial' | 'substitute' | 'unknown'
  userWaiver?: string
}

export interface WorkItemDto {
  id: string
  nativeTaskId?: string
  title: string
  writeScopes: string[]
  dependencies: string[]
  acceptance: string[]
  obligationIds: string[]
  status: WorkItemStatus
  attempt: number
  currentMandateId?: string
  mandatory: boolean
}

export interface MandateDto {
  id: string
  workItemId: string
  anchorVersion: number
  generation: number
  attempt: number
  workerId: string
  reviewerId: string
  writeScopes: string[]
  acceptance: string[]
  knownFailures: string[]
  status: 'prepared' | 'running' | 'reported_done' | 'verifying' | 'accepted' | 'superseded' | 'unknown'
  nativeTaskId?: string
  workerAgentId?: string
  reviewerAgentId?: string
  workerRoute?: ModelRouteDto | null
  reviewerRoute?: ModelRouteDto | null
  routeReason?: string
  policyRevision?: number
  routeSwitches?: RouteSwitchDto[]
}

export interface EvidenceDto {
  id: string
  workItemId: string
  mandateId: string
  attempt: number
  anchorVersion: number
  generation: number
  kind: string
  result: EvidenceResult
  sourceActor: string
  sourceRole: 'worker' | 'reviewer' | 'lead' | 'host' | 'user'
  receipt: Record<string, unknown>
  summary: string
  createdAt: string
}

export interface DecisionDto {
  id: string
  workItemId: string
  mandateId: string
  attempt: number
  anchorVersion: number
  generation: number
  reviewerId: string
  result: EvidenceResult
  evidenceIds: string[]
  reasons: string[]
  createdAt: string
  invalidated: boolean
}

export interface AuditDto {
  id: string
  runId: string
  revision: number
  generation: number
  type: string
  payload: Record<string, unknown>
  actor: string
  timestamp: string
}

export interface GateDto {
  workItemId: string
  attempt: number
  result: EvidenceResult
  missingEvidence: string[]
  violatedObligations: string[]
  staleEvidence: string[]
  reasons: string[]
}

export interface NativeTaskDto {
  id: string
  revision: number
  subject?: string
  description?: string
  ownerId?: string
  ownerName?: string
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'
  blockedBy: string[]
  writeScopes: string[]
  ready: boolean
  writeScopeWarnings: string[]
}

export interface NativeMemberDto {
  id: string
  name: string
  status: string
  activity?: 'running' | 'inactive'
  mode?: string
  modelRoute?: ModelRouteDto | null
  label?: string
  diagnostic?: string
}

export interface GoalDto {
  id?: string
  revision?: number
  objective: string
  phase: 'active' | 'paused' | 'blocked' | 'complete'
  blockedReason?: { code: string; message: string }
  maxGoalRounds?: number
  roundsStarted?: number
  activation?: 'armed' | 'disarmed'
}

export interface SuperAgentProjection {
  schemaVersion: 1
  sessionId: string
  agentPreset: 'super-agent'
  run: RunDto | null
  routeFailures?: RouteFailureDto[]
  currentAnchor: AnchorDto | null
  anchors: AnchorDto[]
  obligations: ObligationDto[]
  openObligations: ObligationDto[]
  workItems: WorkItemDto[]
  mandates: MandateDto[]
  evidence: EvidenceDto[]
  decisions: DecisionDto[]
  audit: AuditDto[]
  gates: GateDto[]
  teamEnabled: boolean
  agentTeam: { enabled: boolean; tasks: NativeTaskDto[]; failure?: string }
  goal: GoalDto | null
  subagentCatalog: NativeMemberDto[]
  blockReasons: string[]
  recovery: { status: 'not_required' | 'ready' | 'unavailable'; reason?: string }
  observedAt: string
}

export class ProjectionDataError extends Error {
  readonly code = 'malformed_projection'

  constructor(message: string) {
    super(message)
    this.name = 'ProjectionDataError'
  }
}

type Row = Record<string, unknown>

function row(value: unknown, path: string): Row {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProjectionDataError(`${path} 必须是对象`)
  }
  return value as Row
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new ProjectionDataError(`${path} 必须是字符串`)
  return value
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined
  return string(value, path)
}

function number(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProjectionDataError(`${path} 必须是有限数字`)
  }
  return value
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new ProjectionDataError(`${path} 必须是布尔值`)
  return value
}

function strings(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new ProjectionDataError(`${path} 必须是字符串数组`)
  return value.map((entry, index) => string(entry, `${path}[${index}]`))
}

function optionalStrings(value: unknown, path: string): string[] | undefined {
  return value === undefined ? undefined : strings(value, path)
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new ProjectionDataError(`${path} 必须是数组`)
  return value
}

function parseArray<T>(value: unknown, path: string, parse: (entry: unknown, path: string) => T): T[] {
  return array(value, path).map((entry, index) => parse(entry, `${path}[${index}]`))
}

function oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  const text = string(value, path)
  if (!allowed.includes(text as T)) throw new ProjectionDataError(`${path} 含不支持的状态: ${text}`)
  return text as T
}

const runStatuses = ['draft', 'active', 'paused', 'blocked', 'needs_user', 'completed'] as const
const workStatuses = ['held', 'ready', 'mandated', 'running', 'reported_done', 'verifying', 'rework', 'accepted', 'blocked', 'superseded'] as const
const evidenceResults = ['pass', 'fail', 'unknown'] as const

function anchor(value: unknown, path: string): AnchorDto {
  const input = row(value, path)
  return {
    id: string(input.id, `${path}.id`),
    version: number(input.version, `${path}.version`),
    supersedes: optionalString(input.supersedes, `${path}.supersedes`),
    supersededBy: optionalString(input.supersededBy, `${path}.supersededBy`),
    latestInstruction: string(input.latestInstruction, `${path}.latestInstruction`),
    definitionOfDone: string(input.definitionOfDone, `${path}.definitionOfDone`),
    constraints: strings(input.constraints, `${path}.constraints`),
    obligationSnapshot: strings(input.obligationSnapshot, `${path}.obligationSnapshot`),
    createdAt: string(input.createdAt, `${path}.createdAt`),
  }
}

function obligation(value: unknown, path: string): ObligationDto {
  const input = row(value, path)
  return {
    id: string(input.id, `${path}.id`),
    kind: oneOf(input.kind, `${path}.kind`, ['requirement', 'prohibition', 'coverage'] as const),
    text: string(input.text, `${path}.text`),
    status: oneOf(input.status, `${path}.status`, ['open', 'met', 'violated', 'waived', 'superseded'] as const),
    evidenceIds: strings(input.evidenceIds, `${path}.evidenceIds`),
    requiredEvidence: optionalStrings(input.requiredEvidence, `${path}.requiredEvidence`),
    coverage: input.coverage === undefined ? undefined : oneOf(input.coverage, `${path}.coverage`, ['full', 'partial', 'substitute', 'unknown'] as const),
    userWaiver: optionalString(input.userWaiver, `${path}.userWaiver`),
  }
}

function workItem(value: unknown, path: string): WorkItemDto {
  const input = row(value, path)
  return {
    id: string(input.id, `${path}.id`),
    nativeTaskId: optionalString(input.nativeTaskId, `${path}.nativeTaskId`),
    title: string(input.title, `${path}.title`),
    writeScopes: strings(input.writeScopes, `${path}.writeScopes`),
    dependencies: strings(input.dependencies, `${path}.dependencies`),
    acceptance: strings(input.acceptance, `${path}.acceptance`),
    obligationIds: strings(input.obligationIds, `${path}.obligationIds`),
    status: oneOf(input.status, `${path}.status`, workStatuses),
    attempt: number(input.attempt, `${path}.attempt`),
    currentMandateId: optionalString(input.currentMandateId, `${path}.currentMandateId`),
    mandatory: boolean(input.mandatory, `${path}.mandatory`),
  }
}

function modelRoute(value: unknown, path: string): ModelRouteDto {
  const input = row(value, path)
  return {
    provider: string(input.provider, `${path}.provider`),
    model: string(input.model, `${path}.model`),
    reasoningEffort: optionalString(input.reasoningEffort, `${path}.reasoningEffort`),
  }
}

function nullableModelRoute(value: unknown, path: string): ModelRouteDto | null {
  return value === null ? null : modelRoute(value, path)
}

function modelPolicy(value: unknown, path: string): ModelPolicyDto {
  const input = row(value, path)
  return {
    mode: oneOf(input.mode, `${path}.mode`, ['locked', 'balanced', 'economy', 'performance'] as const),
    allowedRoutes: parseArray(input.allowedRoutes, `${path}.allowedRoutes`, modelRoute),
    workerRoute: input.workerRoute === undefined ? undefined : modelRoute(input.workerRoute, `${path}.workerRoute`),
    reviewerRoute: input.reviewerRoute === undefined ? undefined : modelRoute(input.reviewerRoute, `${path}.reviewerRoute`),
    allowFailureSwitch: boolean(input.allowFailureSwitch, `${path}.allowFailureSwitch`),
    maxSameRouteRetries: number(input.maxSameRouteRetries, `${path}.maxSameRouteRetries`),
    maxRouteSwitches: number(input.maxRouteSwitches, `${path}.maxRouteSwitches`),
    cooldownMs: input.cooldownMs === undefined ? undefined : number(input.cooldownMs, `${path}.cooldownMs`),
    revision: number(input.revision, `${path}.revision`),
  }
}

function routeSwitch(value: unknown, path: string): RouteSwitchDto {
  const input = row(value, path)
  return {
    id: string(input.id, `${path}.id`),
    mandateId: string(input.mandateId, `${path}.mandateId`),
    from: nullableModelRoute(input.from, `${path}.from`),
    to: nullableModelRoute(input.to, `${path}.to`),
    failureCode: string(input.failureCode, `${path}.failureCode`),
    status: oneOf(input.status, `${path}.status`, ['requested', 'rejected', 'exhausted'] as const),
    reason: string(input.reason, `${path}.reason`),
    attempt: number(input.attempt, `${path}.attempt`),
    generation: number(input.generation, `${path}.generation`),
    actor: string(input.actor, `${path}.actor`),
    createdAt: string(input.createdAt, `${path}.createdAt`),
  }
}

function routeFailure(value: unknown, path: string): RouteFailureDto {
  const input = row(value, path)
  return {
    id: string(input.id, `${path}.id`),
    mandateId: string(input.mandateId, `${path}.mandateId`),
    route: nullableModelRoute(input.route, `${path}.route`),
    failureKind: oneOf(input.failureKind, `${path}.failureKind`, [
      'transient', 'timeout', 'rate_limit', 'quota', 'account_quota', 'provider_unavailable',
      'route_incompatible', 'authentication', 'permission', 'tool_input', 'business_acceptance',
      'snapshot_proof', 'write_scope', 'identity', 'unknown',
    ] as const),
    failureCode: string(input.failureCode, `${path}.failureCode`),
    action: oneOf(input.action, `${path}.action`, ['rejected', 'retry_recorded', 'switch_required'] as const),
    sameRouteRetries: number(input.sameRouteRetries, `${path}.sameRouteRetries`),
    routeSwitches: number(input.routeSwitches, `${path}.routeSwitches`),
    createdAt: string(input.createdAt, `${path}.createdAt`),
  }
}

function mandate(value: unknown, path: string): MandateDto {
  const input = row(value, path)
  return {
    id: string(input.id, `${path}.id`),
    workItemId: string(input.workItemId, `${path}.workItemId`),
    anchorVersion: number(input.anchorVersion, `${path}.anchorVersion`),
    generation: number(input.generation, `${path}.generation`),
    attempt: number(input.attempt, `${path}.attempt`),
    workerId: string(input.workerId, `${path}.workerId`),
    reviewerId: string(input.reviewerId, `${path}.reviewerId`),
    writeScopes: strings(input.writeScopes, `${path}.writeScopes`),
    acceptance: strings(input.acceptance, `${path}.acceptance`),
    knownFailures: strings(input.knownFailures, `${path}.knownFailures`),
    status: oneOf(input.status, `${path}.status`, ['prepared', 'running', 'reported_done', 'verifying', 'accepted', 'superseded', 'unknown'] as const),
    nativeTaskId: optionalString(input.nativeTaskId, `${path}.nativeTaskId`),
    workerAgentId: optionalString(input.workerAgentId, `${path}.workerAgentId`),
    reviewerAgentId: optionalString(input.reviewerAgentId, `${path}.reviewerAgentId`),
    workerRoute: input.workerRoute === undefined ? undefined : nullableModelRoute(input.workerRoute, `${path}.workerRoute`),
    reviewerRoute: input.reviewerRoute === undefined ? undefined : nullableModelRoute(input.reviewerRoute, `${path}.reviewerRoute`),
    routeReason: optionalString(input.routeReason, `${path}.routeReason`),
    policyRevision: input.policyRevision === undefined ? undefined : number(input.policyRevision, `${path}.policyRevision`),
    routeSwitches: input.routeSwitches === undefined ? undefined : parseArray(input.routeSwitches, `${path}.routeSwitches`, routeSwitch),
  }
}

function evidence(value: unknown, path: string): EvidenceDto {
  const input = row(value, path)
  return {
    id: string(input.id, `${path}.id`),
    workItemId: string(input.workItemId, `${path}.workItemId`),
    mandateId: string(input.mandateId, `${path}.mandateId`),
    attempt: number(input.attempt, `${path}.attempt`),
    anchorVersion: number(input.anchorVersion, `${path}.anchorVersion`),
    generation: number(input.generation, `${path}.generation`),
    kind: string(input.kind, `${path}.kind`),
    result: oneOf(input.result, `${path}.result`, evidenceResults),
    sourceActor: string(input.sourceActor, `${path}.sourceActor`),
    sourceRole: oneOf(input.sourceRole, `${path}.sourceRole`, ['worker', 'reviewer', 'lead', 'host', 'user'] as const),
    receipt: row(input.receipt, `${path}.receipt`),
    summary: string(input.summary, `${path}.summary`),
    createdAt: string(input.createdAt, `${path}.createdAt`),
  }
}

function decision(value: unknown, path: string): DecisionDto {
  const input = row(value, path)
  return {
    id: string(input.id, `${path}.id`),
    workItemId: string(input.workItemId, `${path}.workItemId`),
    mandateId: string(input.mandateId, `${path}.mandateId`),
    attempt: number(input.attempt, `${path}.attempt`),
    anchorVersion: number(input.anchorVersion, `${path}.anchorVersion`),
    generation: number(input.generation, `${path}.generation`),
    reviewerId: string(input.reviewerId, `${path}.reviewerId`),
    result: oneOf(input.result, `${path}.result`, evidenceResults),
    evidenceIds: strings(input.evidenceIds, `${path}.evidenceIds`),
    reasons: strings(input.reasons, `${path}.reasons`),
    createdAt: string(input.createdAt, `${path}.createdAt`),
    invalidated: boolean(input.invalidated, `${path}.invalidated`),
  }
}

function audit(value: unknown, path: string): AuditDto {
  const input = row(value, path)
  return {
    id: string(input.id, `${path}.id`),
    runId: string(input.runId, `${path}.runId`),
    revision: number(input.revision, `${path}.revision`),
    generation: number(input.generation, `${path}.generation`),
    type: string(input.type, `${path}.type`),
    payload: row(input.payload, `${path}.payload`),
    actor: string(input.actor, `${path}.actor`),
    timestamp: string(input.timestamp, `${path}.timestamp`),
  }
}

function gate(value: unknown, path: string): GateDto {
  const input = row(value, path)
  return {
    workItemId: string(input.workItemId, `${path}.workItemId`),
    attempt: number(input.attempt, `${path}.attempt`),
    result: oneOf(input.result, `${path}.result`, evidenceResults),
    missingEvidence: strings(input.missingEvidence, `${path}.missingEvidence`),
    violatedObligations: strings(input.violatedObligations, `${path}.violatedObligations`),
    staleEvidence: strings(input.staleEvidence, `${path}.staleEvidence`),
    reasons: strings(input.reasons, `${path}.reasons`),
  }
}

function nativeTask(value: unknown, path: string): NativeTaskDto {
  const input = row(value, path)
  return {
    id: string(input.id, `${path}.id`),
    revision: number(input.revision, `${path}.revision`),
    subject: optionalString(input.subject, `${path}.subject`),
    description: optionalString(input.description, `${path}.description`),
    ownerId: optionalString(input.ownerId, `${path}.ownerId`),
    ownerName: optionalString(input.ownerName, `${path}.ownerName`),
    status: oneOf(input.status, `${path}.status`, ['pending', 'in_progress', 'completed', 'deleted'] as const),
    blockedBy: strings(input.blockedBy, `${path}.blockedBy`),
    writeScopes: strings(input.writeScopes, `${path}.writeScopes`),
    ready: boolean(input.ready, `${path}.ready`),
    writeScopeWarnings: strings(input.writeScopeWarnings, `${path}.writeScopeWarnings`),
  }
}

function nativeMember(value: unknown, path: string): NativeMemberDto {
  const input = row(value, path)
  const activity = input.activity === undefined ? undefined : oneOf(input.activity, `${path}.activity`, ['running', 'inactive'] as const)
  return {
    id: string(input.id, `${path}.id`),
    name: string(input.name, `${path}.name`),
    status: string(input.status, `${path}.status`),
    activity,
    mode: optionalString(input.mode, `${path}.mode`),
    modelRoute: input.modelRoute === undefined ? undefined : nullableModelRoute(input.modelRoute, `${path}.modelRoute`),
    label: optionalString(input.label, `${path}.label`),
    diagnostic: optionalString(input.diagnostic, `${path}.diagnostic`),
  }
}

function goal(value: unknown, path: string): GoalDto | null {
  if (value === null) return null
  const input = row(value, path)
  const blocked = input.blockedReason === undefined ? undefined : row(input.blockedReason, `${path}.blockedReason`)
  return {
    id: optionalString(input.id, `${path}.id`),
    revision: input.revision === undefined ? undefined : number(input.revision, `${path}.revision`),
    objective: string(input.objective, `${path}.objective`),
    phase: oneOf(input.phase, `${path}.phase`, ['active', 'paused', 'blocked', 'complete'] as const),
    blockedReason: blocked === undefined ? undefined : {
      code: string(blocked.code, `${path}.blockedReason.code`),
      message: string(blocked.message, `${path}.blockedReason.message`),
    },
    maxGoalRounds: input.maxGoalRounds === undefined ? undefined : number(input.maxGoalRounds, `${path}.maxGoalRounds`),
    roundsStarted: input.roundsStarted === undefined ? undefined : number(input.roundsStarted, `${path}.roundsStarted`),
    activation: input.activation === undefined ? undefined : oneOf(input.activation, `${path}.activation`, ['armed', 'disarmed'] as const),
  }
}

/** Parse and narrow the exact v1 host DTO; malformed or cross-session data fails closed. */
export function parseHostProjection(value: unknown, expectedSessionId: string): SuperAgentProjection {
  const input = row(value, 'projection')
  if (number(input.schemaVersion, 'projection.schemaVersion') !== 1) {
    throw new ProjectionDataError('projection.schemaVersion 仅支持 1')
  }
  const sessionId = string(input.sessionId, 'projection.sessionId')
  if (sessionId !== expectedSessionId) throw new ProjectionDataError('projection.sessionId 与当前会话不一致')
  oneOf(input.agentPreset, 'projection.agentPreset', ['super-agent'] as const)
  const runValue = input.run
  let run: RunDto | null = null
  if (runValue !== null) {
    const source = row(runValue, 'projection.run')
    run = {
      id: string(source.id, 'projection.run.id'),
      sessionId: string(source.sessionId, 'projection.run.sessionId'),
      objective: string(source.objective, 'projection.run.objective'),
      definitionOfDone: string(source.definitionOfDone, 'projection.run.definitionOfDone'),
      status: oneOf(source.status, 'projection.run.status', runStatuses),
      currentAnchorId: string(source.currentAnchorId, 'projection.run.currentAnchorId'),
      revision: number(source.revision, 'projection.run.revision'),
      generation: number(source.generation, 'projection.run.generation'),
      modelPolicy: source.modelPolicy == null ? undefined : modelPolicy(source.modelPolicy, 'projection.run.modelPolicy'),
      createdAt: string(source.createdAt, 'projection.run.createdAt'),
      updatedAt: string(source.updatedAt, 'projection.run.updatedAt'),
    }
    if (run.sessionId !== expectedSessionId) throw new ProjectionDataError('projection.run.sessionId 与当前会话不一致')
  }
  const team = row(input.agentTeam, 'projection.agentTeam')
  const recovery = row(input.recovery, 'projection.recovery')
  const hostTeamEnabled = boolean(input.teamEnabled, 'projection.teamEnabled')
  const teamEnabled = boolean(team.enabled, 'projection.agentTeam.enabled')
  if (hostTeamEnabled !== teamEnabled) throw new ProjectionDataError('Team 开关在 host DTO 内不一致')
  return {
    schemaVersion: 1,
    sessionId,
    agentPreset: 'super-agent',
    run,
    routeFailures: input.routeFailures === undefined ? undefined : parseArray(input.routeFailures, 'projection.routeFailures', routeFailure),
    currentAnchor: input.currentAnchor === null ? null : anchor(input.currentAnchor, 'projection.currentAnchor'),
    anchors: parseArray(input.anchors, 'projection.anchors', anchor),
    obligations: parseArray(input.obligations, 'projection.obligations', obligation),
    openObligations: parseArray(input.openObligations, 'projection.openObligations', obligation),
    workItems: parseArray(input.workItems, 'projection.workItems', workItem),
    mandates: parseArray(input.mandates, 'projection.mandates', mandate),
    evidence: parseArray(input.evidence, 'projection.evidence', evidence),
    decisions: parseArray(input.decisions, 'projection.decisions', decision),
    audit: parseArray(input.audit, 'projection.audit', audit),
    gates: parseArray(input.gates, 'projection.gates', gate),
    teamEnabled,
    agentTeam: {
      enabled: teamEnabled,
      tasks: parseArray(team.tasks, 'projection.agentTeam.tasks', nativeTask),
      failure: optionalString(team.failure, 'projection.agentTeam.failure'),
    },
    goal: goal(input.goal, 'projection.goal'),
    subagentCatalog: parseArray(input.subagentCatalog, 'projection.subagentCatalog', nativeMember),
    blockReasons: strings(input.blockReasons, 'projection.blockReasons'),
    recovery: {
      status: oneOf(recovery.status, 'projection.recovery.status', ['not_required', 'ready', 'unavailable'] as const),
      reason: optionalString(recovery.reason, 'projection.recovery.reason'),
    },
    observedAt: string(input.observedAt, 'projection.observedAt'),
  }
}

export function isSuperAgentPreset(value: unknown): boolean {
  return value === 'super-agent'
}

export interface StatusMeta {
  label: string
  tone: 'pass' | 'fail' | 'unknown' | 'active' | 'muted'
  icon: string
}

/** reported_done is deliberately not presented as accepted. */
export function workStatusMeta(status: WorkItemStatus): StatusMeta {
  const map: Record<WorkItemStatus, StatusMeta> = {
    held: { label: '等待依赖', tone: 'muted', icon: '○' },
    ready: { label: '待委派', tone: 'unknown', icon: '○' },
    mandated: { label: '已签 Mandate', tone: 'unknown', icon: '→' },
    running: { label: '执行中', tone: 'active', icon: '▶' },
    reported_done: { label: 'Worker 已报完成 · 未验收', tone: 'unknown', icon: '◐' },
    verifying: { label: '独立验收中', tone: 'active', icon: '⌁' },
    rework: { label: '需返工', tone: 'fail', icon: '↺' },
    accepted: { label: '已验收放行', tone: 'pass', icon: '✓' },
    blocked: { label: '已阻断', tone: 'fail', icon: '!' },
    superseded: { label: '已被新锚点替代', tone: 'muted', icon: '×' },
  }
  return map[status]
}

export function evidenceStatusMeta(result: EvidenceResult): StatusMeta {
  if (result === 'pass') return { label: 'pass · 通过', tone: 'pass', icon: '✓' }
  if (result === 'fail') return { label: 'fail · 未通过', tone: 'fail', icon: '×' }
  return { label: 'unknown · 无法确认', tone: 'unknown', icon: '?' }
}

export function runStatusMeta(status: RunStatus): StatusMeta {
  const map: Record<RunStatus, StatusMeta> = {
    draft: { label: '草稿', tone: 'muted', icon: '○' },
    active: { label: '运行中', tone: 'active', icon: '▶' },
    paused: { label: '已暂停', tone: 'muted', icon: 'Ⅱ' },
    blocked: { label: '已阻断', tone: 'fail', icon: '!' },
    needs_user: { label: '需要用户处理', tone: 'unknown', icon: '?' },
    completed: { label: '已完成', tone: 'pass', icon: '✓' },
  }
  return map[status]
}

/** Native Team state is authoritative; conflicting host/native values are unknown. */
export function resolveTeamMode(nativeEnabled: unknown, hostEnabled: unknown): 'enabled' | 'disabled' | 'unknown' {
  if (typeof nativeEnabled !== 'boolean') return 'unknown'
  if (hostEnabled === undefined) return nativeEnabled ? 'enabled' : 'disabled'
  if (typeof hostEnabled !== 'boolean' || nativeEnabled !== hostEnabled) return 'unknown'
  return nativeEnabled ? 'enabled' : 'disabled'
}

export interface MemberView {
  id: string
  name: string
  mode?: string
  activity?: 'running' | 'inactive'
  modelRoute?: ModelRouteDto | null
  status?: string
}

/** Merge native catalog identity with host activity without inferring success. */
export function mergeMembers(nativeCatalog: unknown, hostCatalog: readonly NativeMemberDto[]): MemberView[] {
  const merged = new Map<string, MemberView>()
  if (Array.isArray(nativeCatalog)) {
    for (const value of nativeCatalog) {
      if (typeof value !== 'object' || value === null) continue
      const entry = value as Row
      if (typeof entry.id !== 'string') continue
      merged.set(entry.id, {
        id: entry.id,
        name: typeof entry.name === 'string' ? entry.name : typeof entry.label === 'string' ? entry.label : entry.id,
        mode: typeof entry.mode === 'string' ? entry.mode : undefined,
      })
    }
  }
  for (const entry of hostCatalog) {
    const existing = merged.get(entry.id)
    merged.set(entry.id, {
      ...existing,
      id: entry.id,
      name: entry.name || existing?.name || entry.id,
      mode: entry.mode ?? existing?.mode,
      modelRoute: entry.modelRoute,
      activity: entry.activity,
      status: entry.status,
    })
  }
  return [...merged.values()]
}

export function memberActivityLabel(member: MemberView): string {
  if (member.activity === 'running' || member.status === 'running') return '运行中（不代表成功）'
  if (member.activity === 'inactive' || member.status === 'inactive') return '未运行（不代表完成）'
  if (member.status === 'corrupt') return '目录损坏'
  if (member.status === 'unsupported') return '模式不受支持'
  if (member.status === 'unavailable') return '状态不可用'
  return '活动状态未知'
}

export interface NativeGoalView {
  objective: string
  phase: GoalDto['phase']
  revision?: number
  roundsStarted?: number
  maxGoalRounds?: number
  blockedReason?: { code: string; message: string }
}

/** Read the native goal projection ({ goal, roundsStarted }) without assuming activation. */
export function readNativeGoal(value: unknown): NativeGoalView | null {
  if (typeof value !== 'object' || value === null) return null
  const projection = value as Row
  const source = typeof projection.goal === 'object' && projection.goal !== null ? projection.goal as Row : projection
  if (typeof source.objective !== 'string') return null
  const phase = oneOf(source.phase, 'goal.phase', ['active', 'paused', 'blocked', 'complete'] as const)
  const blocked = typeof source.blockedReason === 'object' && source.blockedReason !== null ? source.blockedReason as Row : undefined
  return {
    objective: source.objective,
    phase,
    revision: typeof source.revision === 'number' ? source.revision : undefined,
    roundsStarted: typeof projection.roundsStarted === 'number' ? projection.roundsStarted : typeof source.roundsStarted === 'number' ? source.roundsStarted : undefined,
    maxGoalRounds: typeof source.maxGoalRounds === 'number' ? source.maxGoalRounds : undefined,
    blockedReason: blocked !== undefined && typeof blocked.code === 'string' && typeof blocked.message === 'string'
      ? { code: blocked.code, message: blocked.message }
      : undefined,
  }
}

export function collectBlockingReasons(projection: SuperAgentProjection, nativeGoal: NativeGoalView | null): string[] {
  const reasons = [...projection.blockReasons]
  if (nativeGoal?.blockedReason !== undefined) {
    reasons.push(`${nativeGoal.blockedReason.code}: ${nativeGoal.blockedReason.message}`)
  }
  if (projection.recovery.status === 'unavailable') {
    reasons.push(projection.recovery.reason ?? '恢复状态不可用')
  }
  const blockedIds = new Set(projection.workItems.filter(item => item.status === 'blocked').map(item => item.id))
  for (const gate of projection.gates) {
    if (blockedIds.has(gate.workItemId) && gate.result !== 'pass') reasons.push(...gate.reasons)
  }
  return [...new Set(reasons.filter(reason => reason.trim() !== ''))]
}

/** Human explanation for a raw block reason; unknown codes stay verbatim (full raw code is rendered separately). */
export function explainBlockReason(reason: string): string {
  const withoutId = reason.replace(/:[^:]*$/, '')
  switch (withoutId) {
    case 'OBLIGATION_OPEN':
      return '义务仍开放（按设计保留的项可经用户豁免关闭）'
    case 'NATIVE_STOP_REQUIRED':
      return '被取代的旧代 mandate 账面停止标记（无绑定任务时仅为记录）'
    case 'GATE_FAIL':
      return 'gate 投影为 fail（若该项已 accepted 且 gate 属旧 generation，为代际 bump 投影；complete 按 historical 语义评估）'
    case 'GATE_UNKNOWN':
      return 'gate 未知（该项尚无 mandate：未派发或占位）'
    default:
      return reason
  }
}
