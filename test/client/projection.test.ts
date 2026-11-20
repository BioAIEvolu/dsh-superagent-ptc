import test from 'node:test'
import assert from 'node:assert/strict'
import {
  collectBlockingReasons,
  evidenceStatusMeta,
  explainBlockReason,
  isSuperAgentPreset,
  memberActivityLabel,
  mergeMembers,
  parseHostProjection,
  readNativeGoal,
  resolveTeamMode,
  workStatusMeta,
} from '../../src/client/projection.ts'
import { emptyProjection, populatedProjection, routedProjection } from './fixtures.ts'

test('empty v1 DTO is a real empty state, not a fabricated run', () => {
  const result = parseHostProjection(emptyProjection(), 'session-1')
  assert.equal(result.run, null)
  assert.equal(result.currentAnchor, null)
  assert.deepEqual(result.workItems, [])
  assert.deepEqual(result.evidence, [])
  assert.equal(result.recovery.status, 'not_required')
})

test('populated host DTO retains anchors, mandates, evidence and audit', () => {
  const result = parseHostProjection(populatedProjection(), 'session-1')
  assert.equal(result.currentAnchor?.version, 2)
  assert.equal(result.workItems[0].status, 'reported_done')
  assert.equal(result.mandates[0].reviewerId, 'reviewer')
  assert.equal(result.evidence[0].result, 'pass')
  assert.equal(result.decisions[0].result, 'unknown')
  assert.equal(result.audit[0].type, 'gate/unknown')
})

test('malformed status, schema and cross-session payloads fail closed', () => {
  assert.throws(() => parseHostProjection(null, 'session-1'), /必须是对象/)
  assert.throws(() => parseHostProjection({ ...emptyProjection(), schemaVersion: 2 }, 'session-1'), /仅支持 1/)
  assert.throws(() => parseHostProjection(emptyProjection('other'), 'session-1'), /当前会话不一致/)
  assert.throws(() => parseHostProjection({ ...emptyProjection(), teamEnabled: true }, 'session-1'), /Team 开关/)
  const wrongPreset = { ...emptyProjection(), agentPreset: 'ptc' }
  assert.throws(() => parseHostProjection(wrongPreset, 'session-1'), /不支持的状态/)
  const invalid = populatedProjection()
  invalid.evidence[0].result = 'passed' as never
  assert.throws(() => parseHostProjection(invalid, 'session-1'), /不支持的状态/)
})

test('reported_done is visually and semantically different from accepted', () => {
  const reported = workStatusMeta('reported_done')
  const accepted = workStatusMeta('accepted')
  assert.match(reported.label, /未验收/)
  assert.equal(reported.tone, 'unknown')
  assert.equal(accepted.label, '已验收放行')
  assert.equal(accepted.tone, 'pass')
  assert.notEqual(reported.icon, accepted.icon)
  assert.equal(evidenceStatusMeta('fail').tone, 'fail')
  assert.equal(evidenceStatusMeta('unknown').tone, 'unknown')
})

test('only exact super-agent preset is eligible', () => {
  assert.equal(isSuperAgentPreset('super-agent'), true)
  for (const preset of ['standard', 'ptc', 'minimal', 'creative', null, undefined, { id: 'super-agent' }]) {
    assert.equal(isSuperAgentPreset(preset), false)
  }
})

test('Team conflicts are unknown and inactive never maps to success', () => {
  assert.equal(resolveTeamMode(false, false), 'disabled')
  assert.equal(resolveTeamMode(true, true), 'enabled')
  assert.equal(resolveTeamMode(false, undefined), 'disabled')
  assert.equal(resolveTeamMode(true, false), 'unknown')
  assert.equal(resolveTeamMode(undefined, true), 'unknown')
  const members = mergeMembers(
    [{ id: 'worker-session', name: 'native-worker', mode: 'continuable' }],
    populatedProjection().subagentCatalog,
  )
  const worker = members.find(member => member.id === 'worker-session')
  assert.equal(worker?.name, 'worker')
  assert.equal(worker?.activity, 'inactive')
  assert.equal(memberActivityLabel(worker!), '未运行（不代表完成）')
  assert.doesNotMatch(memberActivityLabel(worker!), /成功|已完成/)
})

test('native goal and blocking reasons retain unknown evidence semantics', () => {
  const goal = readNativeGoal({
    goal: { id: 'goal-1', revision: 3, objective: '真实目标', phase: 'blocked', blockedReason: { code: 'needs-gui', message: '等待 GUI' } },
    roundsStarted: 2,
  })
  assert.equal(goal?.objective, '真实目标')
  assert.equal(goal?.roundsStarted, 2)
  const reasons = collectBlockingReasons(populatedProjection(), goal)
  assert.ok(reasons.includes('缺少 runtime_gui'))
  assert.ok(reasons.includes('needs-gui: 等待 GUI'))
  assert.equal(new Set(reasons).size, reasons.length)
})

test('run.modelPolicy null from the host digest is tolerated and maps to undefined', () => {
  const value = routedProjection()
  if (value.run === null) throw new Error('fixture run missing')
  ;(value.run as unknown as { modelPolicy?: unknown }).modelPolicy = null
  const result = parseHostProjection(value, 'session-1')
  assert.ok(result.run)
  assert.equal(result.run.modelPolicy, undefined)
  assert.equal(result.run.revision, 4)
})

test('block reason codes keep raw data and add a human explanation only for known prefixes', () => {
  assert.equal(explainBlockReason('OBLIGATION_OPEN:ob_no_dispatch_w2'), '义务仍开放（按设计保留的项可经用户豁免关闭）')
  assert.equal(explainBlockReason('NATIVE_STOP_REQUIRED:mandate_old'), '被取代的旧代 mandate 账面停止标记（无绑定任务时仅为记录）')
  assert.equal(explainBlockReason('GATE_FAIL:W1'), 'gate 投影为 fail（若该项已 accepted 且 gate 属旧 generation，为代际 bump 投影；complete 按 historical 语义评估）')
  assert.equal(explainBlockReason('GATE_UNKNOWN:W2'), 'gate 未知（该项尚无 mandate：未派发或占位）')
  assert.equal(explainBlockReason('未识别的阻断原因'), '未识别的阻断原因')
})
