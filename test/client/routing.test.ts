import test from 'node:test'
import assert from 'node:assert/strict'
import { parseHostProjection } from '../../src/client/projection.ts'
import {
  failureKindMeta,
  formatModelRoute,
  mandateRouteLabel,
  policyModeLabel,
  policyRouteLabel,
  readMandateRoute,
  remainingRouteBudget,
  routeFailureActionLabel,
  routeSwitchStatusLabel,
} from '../../src/client/routing.ts'
import { emptyProjection, populatedProjection, routedProjection } from './fixtures.ts'

test('legacy and empty DTOs keep model policy and failure data absent', () => {
  const empty = parseHostProjection(emptyProjection(), 'session-1')
  assert.equal(empty.run, null)
  assert.equal(empty.routeFailures, undefined)
  const legacy = parseHostProjection(populatedProjection(), 'session-1')
  assert.equal(legacy.run?.modelPolicy, undefined)
  assert.equal(legacy.mandates[0].workerRoute, undefined)
  assert.equal(legacy.mandates[0].reviewerRoute, undefined)
  assert.equal(legacy.mandates[0].routeReason, undefined)
})

test('wire-v1 routing extension preserves policy, routes, reason, switches and failures', () => {
  const result = parseHostProjection(routedProjection(), 'session-1')
  assert.equal(result.run?.modelPolicy?.mode, 'balanced')
  assert.equal(result.run?.modelPolicy?.allowedRoutes.length, 2)
  assert.equal(result.run?.modelPolicy?.maxSameRouteRetries, 1)
  assert.equal(result.run?.modelPolicy?.maxRouteSwitches, 1)
  assert.equal(result.mandates[0].workerRoute?.provider, 'ark')
  assert.equal(result.mandates[0].workerRoute?.model, 'worker-model')
  assert.equal(result.mandates[0].reviewerRoute, null)
  assert.match(result.mandates[0].routeReason ?? '', /Reviewer 继承/)
  assert.equal(result.mandates[0].policyRevision, 3)
  assert.equal(result.mandates[0].routeSwitches?.[0].status, 'exhausted')
  assert.equal(result.routeFailures?.[0].failureKind, 'account_quota')
  assert.equal(result.routeFailures?.[0].sameRouteRetries, 1)
  assert.equal(result.subagentCatalog[0].modelRoute?.model, 'worker-model')
})

test('malformed routes, policy budgets and failure classifications fail closed', () => {
  const badProvider = routedProjection()
  badProvider.run!.modelPolicy!.allowedRoutes[0].provider = 42 as never
  assert.throws(() => parseHostProjection(badProvider, 'session-1'), /provider 必须是字符串/)
  const badBudget = routedProjection()
  badBudget.run!.modelPolicy!.maxRouteSwitches = 'unlimited' as never
  assert.throws(() => parseHostProjection(badBudget, 'session-1'), /maxRouteSwitches 必须是有限数字/)
  const badFailure = routedProjection()
  badFailure.routeFailures![0].failureKind = 'business' as never
  assert.throws(() => parseHostProjection(badFailure, 'session-1'), /不支持的状态/)
  const badSwitch = routedProjection()
  badSwitch.mandates[0].routeSwitches![0].status = 'completed' as never
  assert.throws(() => parseHostProjection(badSwitch, 'session-1'), /不支持的状态/)
})

test('null means explicit inheritance while undefined remains unrecorded', () => {
  assert.equal(mandateRouteLabel(null), '继承（Mandate 显式记录）')
  assert.equal(mandateRouteLabel(undefined), '未记录（历史 Mandate）')
  assert.equal(policyRouteLabel(undefined), '未指定（由 Mandate 决定）')
  assert.equal(formatModelRoute({ provider: 'ark', model: 'k2', reasoningEffort: 'high' }), 'ark / k2 · reasoning high')
  assert.equal(policyModeLabel('economy'), 'economy · 经济')
})

test('failure mapping never turns business or identity failures into automatic switches', () => {
  assert.equal(failureKindMeta('timeout').handling, '可按预算重试')
  assert.equal(failureKindMeta('account_quota').handling, '可按授权切换')
  for (const kind of ['authentication', 'permission', 'tool_input', 'business_acceptance', 'snapshot_proof', 'write_scope', 'identity'] as const) {
    assert.equal(failureKindMeta(kind).handling, '不自动重试或切换')
    assert.equal(failureKindMeta(kind).tone, 'fail')
  }
  assert.equal(failureKindMeta('unknown').handling, '失败封闭，不盲目切换')
  assert.equal(routeFailureActionLabel('switch_required'), '需要切换或用户处理')
  assert.equal(routeSwitchStatusLabel('exhausted'), '预算耗尽')
})

test('native route readback matches explicit routes, preserves inheritance and fails mismatch to unknown', () => {
  const value = routedProjection()
  const mandate = value.mandates[0]
  const worker = readMandateRoute(mandate.workerRoute, mandate.workerAgentId, value.subagentCatalog)
  assert.equal(worker.status, 'matched')
  assert.match(worker.label, /ark \/ worker-model/)
  const reviewer = readMandateRoute(mandate.reviewerRoute, mandate.reviewerAgentId, value.subagentCatalog)
  assert.equal(reviewer.status, 'inherited')
  assert.match(reviewer.label, /fallback \/ reviewer-model/)
  assert.equal(readMandateRoute(mandate.workerRoute, undefined, value.subagentCatalog).status, 'unknown')
  assert.equal(readMandateRoute(mandate.workerRoute, 'missing', value.subagentCatalog).status, 'unknown')
  const mismatch = readMandateRoute({ provider: 'other', model: 'wrong' }, mandate.workerAgentId, value.subagentCatalog)
  assert.equal(mismatch.status, 'unknown')
  assert.match(mismatch.label, /路由不一致/)
  const cold = structuredClone(value)
  cold.subagentCatalog[0].modelRoute = undefined
  assert.equal(readMandateRoute(mandate.workerRoute, mandate.workerAgentId, cold.subagentCatalog).status, 'unknown')
})

test('remaining budgets use real RouteFailure counters and clamp at exhausted', () => {
  const failure = routedProjection().routeFailures![0]
  assert.equal(remainingRouteBudget(1, failure.sameRouteRetries), 0)
  assert.equal(remainingRouteBudget(1, failure.routeSwitches), 0)
  assert.equal(remainingRouteBudget(3, 1), 2)
  assert.equal(remainingRouteBudget(1, 9), 0)
})
