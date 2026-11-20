import type { SuperAgentProjection } from '../../src/client/projection.ts'

/** Test-only wire fixture. Production components never import this module. */
export function emptyProjection(sessionId = 'session-1'): SuperAgentProjection {
  return {
    schemaVersion: 1,
    sessionId,
    agentPreset: 'super-agent',
    run: null,
    currentAnchor: null,
    anchors: [],
    obligations: [],
    openObligations: [],
    workItems: [],
    mandates: [],
    evidence: [],
    decisions: [],
    audit: [],
    gates: [],
    teamEnabled: false,
    agentTeam: { enabled: false, tasks: [] },
    goal: null,
    subagentCatalog: [],
    blockReasons: [],
    recovery: { status: 'not_required' },
    observedAt: '2026-11-18T03:00:00.000Z',
  }
}

export function populatedProjection(): SuperAgentProjection {
  const value = emptyProjection()
  value.run = {
    id: 'run-1', sessionId: value.sessionId, objective: '交付真实监管面板',
    definitionOfDone: '独立证据通过', status: 'blocked', currentAnchorId: 'anchor-2',
    revision: 4, generation: 2, createdAt: '2026-11-18T01:00:00.000Z', updatedAt: '2026-11-18T02:00:00.000Z',
  }
  value.currentAnchor = {
    id: 'anchor-2', version: 2, supersedes: 'anchor-1', latestInstruction: '使用最新约束',
    definitionOfDone: '真实 GUI 通过', constraints: ['不伪造数据'], obligationSnapshot: ['req-1'],
    createdAt: '2026-11-18T02:00:00.000Z',
  }
  value.anchors = [value.currentAnchor]
  value.obligations = [{
    id: 'req-1', kind: 'requirement', text: '真实 GUI 验收', status: 'open', evidenceIds: [], requiredEvidence: ['runtime_gui'],
  }]
  value.openObligations = [...value.obligations]
  value.workItems = [{
    id: 'work-1', nativeTaskId: 'task-1', title: '实现面板', writeScopes: ['src/client'],
    dependencies: [], acceptance: ['真实 GUI'], obligationIds: ['req-1'], status: 'reported_done',
    attempt: 2, currentMandateId: 'mandate-2', mandatory: true,
  }]
  value.mandates = [{
    id: 'mandate-2', workItemId: 'work-1', anchorVersion: 2, generation: 2, attempt: 2,
    workerId: 'worker', reviewerId: 'reviewer', writeScopes: ['src/client'], acceptance: ['真实 GUI'],
    knownFailures: [], status: 'reported_done', nativeTaskId: 'task-1', workerAgentId: 'worker-session',
  }]
  value.evidence = [{
    id: 'evidence-1', workItemId: 'work-1', mandateId: 'mandate-2', attempt: 2, anchorVersion: 2,
    generation: 2, kind: 'unit', result: 'pass', sourceActor: 'worker', sourceRole: 'worker',
    receipt: { exitCode: 0 }, summary: '单元测试通过', createdAt: '2026-11-18T02:30:00.000Z',
  }]
  value.decisions = [{
    id: 'decision-1', workItemId: 'work-1', mandateId: 'mandate-2', attempt: 2, anchorVersion: 2,
    generation: 2, reviewerId: 'reviewer', result: 'unknown', evidenceIds: ['evidence-1'],
    reasons: ['缺少 runtime_gui'], createdAt: '2026-11-18T02:40:00.000Z', invalidated: false,
  }]
  value.audit = [{
    id: 'audit-1', runId: 'run-1', revision: 4, generation: 2, type: 'gate/unknown',
    payload: { workItemId: 'work-1' }, actor: 'reviewer', timestamp: '2026-11-18T02:40:00.000Z',
  }]
  value.gates = [{
    workItemId: 'work-1', attempt: 2, result: 'unknown', missingEvidence: ['runtime_gui'],
    violatedObligations: [], staleEvidence: [], reasons: ['缺少 runtime_gui'],
  }]
  value.blockReasons = ['缺少 runtime_gui']
  value.subagentCatalog = [
    { id: 'worker-session', name: 'worker', status: 'inactive', activity: 'inactive', mode: 'continuable' },
    { id: 'reviewer-session', name: 'reviewer', status: 'running', activity: 'running', mode: 'continuable' },
  ]
  return value
}

export function routedProjection(): SuperAgentProjection {
  const value = populatedProjection()
  const workerRoute = { provider: 'ark', model: 'worker-model', reasoningEffort: 'medium' }
  const fallbackRoute = { provider: 'fallback', model: 'reviewer-model', reasoningEffort: 'high' }
  if (value.run === null) throw new Error('fixture run missing')
  value.run.modelPolicy = {
    mode: 'balanced', allowedRoutes: [workerRoute, fallbackRoute], workerRoute,
    allowFailureSwitch: true, maxSameRouteRetries: 1, maxRouteSwitches: 1, cooldownMs: 500, revision: 3,
  }
  value.subagentCatalog[0].modelRoute = workerRoute
  value.subagentCatalog[1].modelRoute = fallbackRoute
  value.mandates[0].reviewerAgentId = 'reviewer-session'
  value.mandates[0].workerRoute = workerRoute
  value.mandates[0].reviewerRoute = null
  value.mandates[0].routeReason = 'Worker 使用授权编码模型；Reviewer 继承宿主模型'
  value.mandates[0].policyRevision = 3
  value.mandates[0].routeSwitches = [{
    id: 'switch-1', mandateId: 'mandate-2', from: workerRoute, to: fallbackRoute,
    failureCode: 'ACCOUNT_QUOTA', status: 'exhausted', reason: '账户额度耗尽，已达到切换预算',
    attempt: 2, generation: 2, actor: 'lead', createdAt: '2026-11-18T02:50:00.000Z',
  }]
  value.routeFailures = [{
    id: 'failure-1', mandateId: 'mandate-2', route: workerRoute, failureKind: 'account_quota',
    failureCode: 'ACCOUNT_QUOTA', action: 'switch_required', sameRouteRetries: 1, routeSwitches: 1,
    createdAt: '2026-11-18T02:50:00.000Z',
  }]
  return value
}
