import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const workspace = path.resolve(here, '../../..')
const outputDir = path.resolve(process.env.DSH_VALIDATION_DIR || path.join(workspace, '.validation/rc5'))
const read = async name => JSON.parse(await readFile(path.join(outputDir, name), 'utf8'))
const readOptional = async name => {
  try { return await read(name) } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}
const [initial, presetMenu, selected, reloaded, rightSidebar, moreTools, footer, superPanel, standardIsolation, ptcIsolation, pluginDetail, hostRpc, observations] = await Promise.all([
  read('dom-initial.json'),
  read('dom-preset-menu.json'),
  read('dom-preset-selected.json'),
  read('dom-reloaded.json'),
  read('dom-right-sidebar.json'),
  read('dom-more-tools.json'),
  read('dom-subagent-footer.json'),
  read('dom-super-agent-panel.json'),
  readOptional('dom-preset-standard.json'),
  readOptional('dom-preset-ptc.json'),
  read('dom-plugin-detail.json'),
  read('host-projection-rpc.json'),
  read('runtime-observations.json'),
])

const checks = []
const add = (id, status, detail, evidence) => checks.push({ id, status, detail, evidence })
const apis = observations.apiObservations || []
const requests = observations.requests || []
const hostValidation = hostRpc.validation || {}
const hostProjection = hostRpc.body?.result?.value
const projectionResponse = apis.findLast(entry => entry.endpoint === '/api/session/projections'
  && entry.body?.result?.value?.values?.agentPreset === 'super-agent')
const selectedSessionId = hostValidation.expectedSessionId
const blankSession = apis.flatMap(entry => entry.endpoint === '/api/session/list' ? entry.body?.result?.value?.items || [] : [])
  .findLast(item => item.sessionId === selectedSessionId && item.blank === true)
const selectResponse = apis.findLast(entry => entry.endpoint === '/api/agentPresets/select'
  && entry.body?.result?.value === 'super-agent')
const modelCatalog = apis.findLast(entry => entry.endpoint === '/api/session/modelCatalog' && entry.body?.result?.ok === true)
  ?.body?.result?.value
const clientModuleRequested = requests.some(entry => entry.resourceType === 'script'
  && typeof entry.url === 'string' && entry.url.includes('dsh-superagent-ptc/client.js'))
const consoleErrors = (observations.consoleEvents || []).filter(entry => entry.type === 'error')
const unexpectedFailures = (observations.failures || []).filter(entry =>
  !(entry.url === '/plugins/events' && entry.error === 'net::ERR_ABORTED'))

add('page-load', observations.navigationError === null && initial.title === 'DeepSeek Harness' ? 'pass' : 'fail',
  '真实系统 Chrome 完成页面导航并渲染 DeepSeek Harness。', ['dom-initial.json', '01-loaded.png'])
const presetText = 'SuperAgent PTC 模式\nPTC+ 目标锚点 + 有界委派 + 独立验收 + 证据放行；保留未决义务，无证据不放行。'
add('preset-selector-description', presetMenu.bodyText.includes(presetText) ? 'pass' : 'fail',
  '选择器包含 SuperAgent PTC及预期完整描述。', ['dom-preset-menu.json', '02-preset-menu.png'])
add('blank-session-selection', blankSession && selected.interactive.some(item => item.text === 'SuperAgent PTC 模式') ? 'pass' : 'fail',
  '实际会话列表项 blank=true，且选择器显示 SuperAgent PTC；未发送消息。', ['dom-preset-selected.json', 'runtime-observations.json', '03-preset-selected.png'])
add('agent-preset', projectionResponse && selectResponse && hostValidation.agentPreset === 'super-agent' ? 'pass' : 'fail',
  'agentPresets/select、session/projections 与宿主投影均为 super-agent。', ['runtime-observations.json', 'host-projection-rpc.json'])
const componentCounts = pluginDetail.bodyText.match(/共 (\d+) 个 · (\d+) 运行中/)
const allComponentsRunning = componentCounts && Number(componentCounts[1]) > 0 && componentCounts[1] === componentCounts[2]
add('host-no-broken', hostValidation.rpcOk === true && hostValidation.sessionMatches === true
  && allComponentsRunning && !/broken|加载失败|运行失败/i.test(pluginDetail.bodyText) ? 'pass' : 'fail',
  allComponentsRunning
    ? '插件详情显示 ' + componentCounts[2] + '/' + componentCounts[1] + ' 组件运行中，宿主只读 RPC 成功且会话匹配，未观察到 broken。'
    : '插件组件运行状态或宿主 RPC 不满足验收。',
  ['dom-plugin-detail.json', '07-plugin-detail.png', 'host-projection-rpc.json'])
add('projection-rpc', hostRpc.httpStatus === 200 && hostValidation.transportOk === true && hostValidation.rpcOk === true
  && hostProjection?.schemaVersion === 1 && hostProjection?.agentPreset === 'super-agent'
  && hostProjection?.sessionId === selectedSessionId && hostProjection?.run === null ? 'pass' : 'fail',
  '只读投影 RPC 返回 HTTP 200、schema v1、匹配会话和 run=null。', ['host-projection-rpc.json', 'runtime-observations.json'])
const clientMounted = reloaded.plugin.styles > 0 && clientModuleRequested
add('client-mount', clientMounted ? 'pass' : 'fail',
  '客户端模块请求=' + clientModuleRequested + '，style=' + reloaded.plugin.styles + '，footer=' + footer.entryCount
    + '，panel=' + (superPanel.panelUi?.panels || 0) + '。',
  ['dom-reloaded.json', 'dom-subagent-footer.json', 'dom-super-agent-panel.json', 'runtime-observations.json'])
const composerDockAbsent = footer.entryCount === 0 && footer.entryVisible === false && footer.plugin.entries === 0
add('composer-dock-absent', composerDockAbsent ? 'pass' : 'fail',
  composerDockAbsent ? '按用户既定决定，空白会话未注册或显示 composer dock。'
    : 'composer dock 按决定应移除，但当前 entryCount=' + footer.entryCount + '，entryVisible=' + footer.entryVisible + '。',
  ['dom-subagent-footer.json'])
const rightMounted = superPanel.panelUi?.panels > 0 && superPanel.panelUi?.unavailableAlerts === 0
  && /当前会话尚无监管 Run/.test(superPanel.panelUi?.emptyRun || '')
  && /Host 观察时间/.test(superPanel.panelUi?.observedAt || '')
add('right-sidebar-entry', rightMounted ? 'pass' : footer.entryVisible ? 'fail' : 'unknown',
  rightMounted ? '已通过真实 footer 入口打开右栏；面板 RPC 完成，显示空 Run 和 Host 观察时间，无 unavailable。'
    : footer.entryVisible
      ? 'footer 入口可见，但右栏空 Run 面板或 RPC 状态不满足验收。'
      : '空白会话尚无子 Agent/footer 入口；右栏真实委派后的展示保持 unknown，等待真实 Run 验证。',
  ['dom-right-sidebar.json', '05-right-sidebar.png', 'dom-more-tools.json', '05b-more-tools.png', 'dom-super-agent-panel.json', ...(rightMounted ? ['05d-super-agent-panel.png'] : [])])
for (const [id, label, state, screenshot] of [
  ['standard', '标准模式', standardIsolation, '08-standard.png'],
  ['ptc', 'PTC 模式', ptcIsolation, '09-ptc.png'],
]) {
  if (!state || state.status === 'unknown') {
    add(id + '-preset-isolation', 'unknown', label + ' 隔离未获得有效页面证据：' + (state?.reason || '未执行') + '。', ['runtime-observations.json'])
    continue
  }
  const selectionObserved = apis.some(entry => entry.endpoint === '/api/agentPresets/select' && entry.body?.result?.value === id)
  const isolated = selectionObserved && state.isolation?.presetLabel === label
    && state.isolation?.entries === 0 && state.isolation?.visibleEntries === 0 && state.isolation?.panels === 0
  add(id + '-preset-isolation', isolated ? 'pass' : 'fail',
    isolated ? label + ' 选择响应正确，Super Agent 入口与面板均为 0。'
      : label + ' 的选择响应或 Super Agent 入口/面板隔离不满足验收。',
    ['dom-preset-' + id + '.json', screenshot, 'runtime-observations.json'])
}
add('console-errors', consoleErrors.length === 0 && (observations.pageErrors || []).length === 0 ? 'pass' : 'fail',
  'console.error=' + consoleErrors.length + '，pageerror=' + (observations.pageErrors || []).length + '。', ['runtime-observations.json'])
add('network-errors', (observations.badResponses || []).length === 0 && unexpectedFailures.length === 0 ? 'pass' : 'fail',
  'HTTP >=400=' + (observations.badResponses || []).length + '，非重载中止 requestfailed=' + unexpectedFailures.length
    + '；/plugins/events 的 ERR_ABORTED 仅由主动 reload 取消。', ['runtime-observations.json'])
const modelUnavailable = selected.bodyText.includes('请选择模型') && Array.isArray(modelCatalog?.routableProviders)
  && modelCatalog.routableProviders.length === 0
add('ptc-execution', 'unknown',
  modelUnavailable ? '没有可路由模型，未发送模型任务，PTC 执行链未验证。' : '未执行模型任务，PTC 执行链未验证。',
  ['dom-preset-selected.json', 'runtime-observations.json'])
add('delegation-chain', 'unknown',
  '未创建 goal、任务或子 Agent；委派链没有运行证据，保持 unknown。', ['host-projection-rpc.json'])

const counts = {
  pass: checks.filter(check => check.status === 'pass').length,
  fail: checks.filter(check => check.status === 'fail').length,
  unknown: checks.filter(check => check.status === 'unknown').length,
}
const summary = {
  generatedAt: new Date().toISOString(),
  browser: observations.browser,
  overall: counts.fail > 0 ? 'fail' : counts.unknown > 0 ? 'unknown' : 'pass',
  counts,
  checks,
  sensitiveData: 'Evidence contains URL paths only; credentials and sensitive fields are redacted.',
}
await writeFile(path.join(outputDir, 'validation-summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8')
console.log(JSON.stringify(summary, null, 2))
if (counts.fail > 0) process.exitCode = 1