import { writeFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'

const mode = process.argv[2] || 'start'
if (mode !== 'start') throw new Error('This driver mode must be start')
const target = process.env.DSH_TEST_URL
if (!target) throw new Error('DSH_TEST_URL is required')
const outputDir = path.resolve(process.env.DSH_VALIDATION_DIR || '.validation/live')
const suppliedToken = new URL(target).searchParams.get('token')
const chromePath = process.env.DSH_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const redact = value => {
  let text = String(value)
  if (suppliedToken) text = text.split(suppliedToken).join('[REDACTED]')
  return text.replace(/([?&](?:token|access_token|api_key|key)=)[^&#\s]+/gi, '$1[REDACTED]')
}
const safeUrl = value => {
  try { return new URL(value).pathname } catch { return redact(value) }
}
const clean = value => {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map(clean)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [/token|secret|password|credential|api.?key|authorization|cookie/i.test(key) ? '[REDACTED]' : clean(item)] && [key, /token|secret|password|credential|api.?key|authorization|cookie/i.test(key) ? '[REDACTED]' : clean(item)]))
  return value
}
const save = async (name, value) => writeFile(path.join(outputDir, name), JSON.stringify(clean(value), null, 2) + '\n', 'utf8')
await mkdir(outputDir, { recursive: true })

const prompt = process.env.DSH_LIVE_PROMPT_FILE ? await readFile(process.env.DSH_LIVE_PROMPT_FILE, 'utf8') : `这是独立 super-agent-live 测试会话。请真实执行 Super Agent 监管链，不要只给方案或文字自述。
文件边界：只允许读取工作区 fixture.txt；本阶段不得写任何项目文件。后续第二项唯一允许写入工作区 result.md，但本阶段先不要执行第二项。不得修改其他文件、profile、产品源码或其他会话。
fixture.txt 内容为两行：fixture-id: super-agent-live；verification-code: alpha-42。

请用当前真实模型与真实原生工具完成第一阶段：
1. 检查实际可用工具；通过 run_code 内 SDK 的 super_run/super_anchor/super_mandate/super_evidence/super_review/super_snapshot 操作，不要伪造工具回执。创建监管 Run，明确 DoD、写作用域与 obligations：fixture 只读核验（coverage/full、sourceId=fixture.txt）、原生投递核验（coverage/full、verification=mandate_delivery、sourceId=native-mandate-delivery）、无证据不放行、Worker 不可 self-pass、Reviewer 必须独立且 native standard 只读、第二项只能在第一项 accepted 后执行。W1 使用 gateProfile=coverage、hostContractRequired=false，W2 初始 held。
2. plan 两个有依赖的小工作项：W1 只读核验 fixture 的两项精确内容；W2 依赖 W1，未来在第一项 accepted 后才允许在 validation-live 写 result.md。W2 初始必须 held。给出真实 runId/workItemIds/revisions。
3. 在正向执行前做负向验证并保留真实回执：无证据 evaluate 不得 pass；尝试 root/Worker self-pass、Worker 自报 coverage、Worker 与 Reviewer 相同、Reviewer 不符合 native standard 或越权 release，必须失败。只记录实际发生的错误码；不得为了凑错误而伪造。每次检查后确认 W1 未 accepted、W2 仍 held。
4. 创建子 Agent 前用 list_subagent_models 查询授权；Worker 与 Reviewer 均显式请求 ark-agent-plan / glm-5.3-flash / high，若该路由未获授权立即停止。Worker 省略 agent_preset 以继承 super-agent，Reviewer 显式 agent_preset: 'standard'。创建后用 super_route inspect/model.current/request header 读回实际路由，不可读标 unknown。使用两者真实 native SessionId 与 super_mandate prepare/bind；Lead 先发送当前 Mandate 和 ACTION NOW，Worker 执行后通过 super_mandate report 报完成，只有 reported_done 后才 super_mandate bindReviewer 唤醒 Reviewer。Reviewer 不得写文件。
5. 记录或观察真实原生只读工具证据；由 Reviewer 调 super_evidence verify（verification=mandate_delivery、kind=coverage），由 Host 核对实发与实收并生成 host-observed coverage。Reviewer 独立记录 fixture 的 coverage/full 证据，再用 super_review evaluate/decide/release。只有真实有效证据与独立 Reviewer 通过后才释放 W1。
6. 验证 W1 accepted 且 W2 从 held 变 ready，然后停止，不要执行 W2、不要创建 result.md。读取 super_snapshot，报告真实 run/workItem/mandate/Worker/Reviewer/evidence/gate IDs、各状态、实际工具链与失败码。若任何能力不可用，明确 unknown 并停止，不要宣称完成。`

const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--disable-dev-shm-usage'] })
const context = await browser.newContext({ viewport: { width: 1500, height: 1100 }, locale: 'zh-CN' })
const page = await context.newPage()
const consoleEvents = []
const pageErrors = []
const badResponses = []
const requestPaths = []
const responseObservations = []
const creates = []
let listPayload = null
page.on('console', message => consoleEvents.push({ type: message.type(), text: redact(message.text()) }))
page.on('pageerror', error => pageErrors.push({ message: redact(error.message) }))
page.on('request', request => {
  const pathname = safeUrl(request.url())
  requestPaths.push({ method: request.method(), path: pathname, resourceType: request.resourceType() })
  if (pathname === '/api/session/list' && request.postData()) {
    try { listPayload = JSON.parse(request.postData()).payload } catch {}
  }
})
page.on('response', response => {
  const pathname = safeUrl(response.url())
  if (response.status() >= 400) badResponses.push({ status: response.status(), path: pathname })
  if (['/api/session/create', '/api/agentPresets/select', '/api/session/list'].includes(pathname)) {
    void response.json().then(body => {
      if (pathname === '/api/session/create') creates.push(body)
      if (pathname === '/api/agentPresets/select') responseObservations.push({ endpoint: pathname, body })
    }).catch(() => {})
  }
})
const call = async (endpoint, payload) => page.evaluate(async ({ endpoint, payload }) => {
  const response = await fetch('api/' + endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: endpoint, payload }),
  })
  return { httpStatus: response.status, body: await response.json() }
}, { endpoint, payload })

let sessionId
let fatalError = null
let sawRunning = false
let finalItem = null
let finalFailures = 0
let modelLabel = null
const startedAt = Date.now()
try {
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(10000)
  const close = page.getByRole('button', { name: '关闭', exact: true })
  if (await close.isVisible().catch(() => false)) await close.click()
  const newSession = page.getByRole('button', { name: '新建会话', exact: true }).last()
  await newSession.click()
  await page.waitForTimeout(1500)
  const trigger = page.getByTitle('选择新任务使用的 Agent 预设')
  await trigger.click()
  const superItem = page.getByRole('menuitem', { name: /^SuperAgent PTC/ })
  await superItem.waitFor({ state: 'visible', timeout: 10000 })
  await superItem.click()
  await page.waitForTimeout(8000)
  const model = page.getByRole('button', { name: /选择模型，当前/ })
  modelLabel = await model.getAttribute('aria-label').catch(() => null)
  const editor = page.getByRole('textbox', { name: '描述你想要构建的内容, / 调用指令, @ 文件或对话', exact: true })
  await editor.fill(prompt)
  await page.screenshot({ path: path.join(outputDir, 'live-01-before-send.png'), fullPage: true })
  await save('live-initial-prompt.json', { prompt, modelLabel })
  const send = page.getByRole('button', { name: '发送消息', exact: true })
  await send.click()
  await page.waitForTimeout(3000)
  const create = creates.findLast(body => body?.result?.value?.sessionId)
  sessionId = create?.result?.value?.sessionId
  if (!sessionId) {
    const projectionResponse = await call('session/projections', { args: { request: {} } }).catch(() => null)
    await save('live-start-projection-fallback.json', projectionResponse)
  }
  await save('live-session.json', { sessionId, modelLabel, phase: 'started', startedAt: new Date(startedAt).toISOString() })
  const deadline = Date.now() + 20 * 60 * 1000
  let polls = 0
  while (sessionId && listPayload && Date.now() < deadline) {
    polls++
    await page.waitForTimeout(8000)
    const listed = await call('session/list', listPayload).catch(error => ({ error: String(error) }))
    const items = listed.body?.result?.value?.items || []
    finalItem = items.find(item => item.sessionId === sessionId) || finalItem
    const running = finalItem?.running === true
    if (running) sawRunning = true
    const currentText = await page.locator('body').innerText()
    finalFailures = currentText.split('本轮运行失败').length - 1
    if (polls % 3 === 0 || running !== sawRunning) console.log(JSON.stringify({ phase: 'start', polls, running, sawRunning, elapsedMs: Date.now() - startedAt }))
    await save('live-progress.json', { phase: 'start', sessionId, polls, running, sawRunning, elapsedMs: Date.now() - startedAt, item: finalItem })
    if ((sawRunning && !running) || finalFailures > 0) break
  }
  await page.waitForTimeout(5000)
  await page.screenshot({ path: path.join(outputDir, 'live-02-start-final.png'), fullPage: true })
  const bodyText = await page.locator('body').innerText()
  await save('live-start-final-dom.json', { bodyText, title: await page.title() })
  if (sessionId) {
    const host = await call('dsh-super-agent-mode/projection', { sessionId })
    await save('host-projection-after-start.json', host)
  }
  await save('live-session.json', { sessionId, modelLabel, phase: 'start-finished', title: finalItem?.projections?.values?.title || finalItem?.title || null, startedAt: new Date(startedAt).toISOString(), elapsedMs: Date.now() - startedAt })
  await save('live-start-run.json', { sessionId, modelLabel, sawRunning, finalRunning: finalItem?.running, finalItem, finalFailures, elapsedMs: Date.now() - startedAt, timedOut: Date.now() >= deadline, fatalError })
} catch (error) {
  fatalError = error instanceof Error ? error.message : String(error)
  await save('live-start-run.json', { sessionId, modelLabel, sawRunning, finalItem, elapsedMs: Date.now() - startedAt, fatalError })
  await page.screenshot({ path: path.join(outputDir, 'live-start-error.png'), fullPage: true }).catch(() => {})
} finally {
  await save('live-start-observations.json', { consoleEvents, pageErrors, badResponses, requestPaths, responseObservations, creates, fatalError })
  await browser.close()
}
if (fatalError) process.exitCode = 1