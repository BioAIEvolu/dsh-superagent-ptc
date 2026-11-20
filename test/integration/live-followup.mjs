import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'
const target = process.env.DSH_TEST_URL
const outputDir = path.resolve(process.env.DSH_VALIDATION_DIR)
const prompt = await readFile(process.env.DSH_LIVE_FOLLOWUP_FILE, 'utf8')
const token = new URL(target).searchParams.get('token')
const redact = value => token ? String(value).split(token).join('[REDACTED]') : String(value)
const state = JSON.parse(await readFile(path.join(outputDir, 'live-session.json'), 'utf8'))
const browser = await chromium.launch({ executablePath: process.env.DSH_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true })
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } })
const consoleEvents = [], pageErrors = [], badResponses = [], requestPaths = []
let listPayload = null
page.on('console', m => consoleEvents.push({ type: m.type(), text: redact(m.text()) }))
page.on('pageerror', e => pageErrors.push(redact(e.message)))
page.on('request', request => {
  try {
    const url = new URL(request.url())
    requestPaths.push({ method: request.method(), path: url.pathname })
    if (url.pathname === '/api/session/list' && request.postData()) listPayload = JSON.parse(request.postData()).payload
  } catch {}
})
page.on('response', response => { if (response.status() >= 400) badResponses.push({ status: response.status(), path: new URL(response.url()).pathname }) })
const call = async (endpoint, payload) => page.evaluate(async ({ endpoint, payload }) => {
  const response = await fetch('api/' + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: endpoint, payload }) })
  return { httpStatus: response.status, body: await response.json() }
}, { endpoint, payload })
const startedAt = Date.now()
let fatalError = null, sawRunning = false, finalItem = null, baselineFailures = 0, finalFailures = 0
try {
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(10000)
  const title = state.title
  if (!await page.getByText(title, { exact: true }).first().isVisible().catch(() => false)) {
    const search = page.getByPlaceholder('搜索会话名称')
    if (await search.isVisible().catch(() => false)) {
      await search.fill(title)
      await page.waitForTimeout(1200)
    }
  }
  const workspaceText = page.getByText(title, { exact: true }).first()
  if (await workspaceText.isVisible().catch(() => false)) {
    await workspaceText.click()
    await page.waitForTimeout(2000)
  }
  await page.getByText(title, { exact: true }).last().click()
  await page.waitForTimeout(6000)
  baselineFailures = (await page.locator('body').innerText()).split('本轮运行失败').length - 1
  const editor = page.locator('div[contenteditable="true"][role="textbox"]').last()
  await editor.fill(prompt)
  await page.screenshot({ path: path.join(outputDir, 'live-05-followup-before-send.png'), fullPage: true })
  await writeFile(path.join(outputDir, 'live-followup-prompt.json'), JSON.stringify({ prompt, baselineFailures }, null, 2) + '\n')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await page.waitForTimeout(3000)
  const deadline = Date.now() + 20 * 60 * 1000
  let polls = 0
  while (listPayload && Date.now() < deadline) {
    polls++
    await page.waitForTimeout(8000)
    const listed = await call('session/list', listPayload).catch(error => ({ error: String(error) }))
    const items = listed.body?.result?.value?.items || []
    finalItem = items.find(item => item.sessionId === state.sessionId) || finalItem
    const running = finalItem?.running === true
    if (running) sawRunning = true
    const text = await page.locator('body').innerText()
    finalFailures = text.split('本轮运行失败').length - 1
    if (polls % 3 === 0) console.log(JSON.stringify({ phase: 'followup', polls, running, sawRunning, finalFailures, elapsedMs: Date.now() - startedAt }))
    await writeFile(path.join(outputDir, 'live-followup-progress.json'), JSON.stringify({ sessionId: state.sessionId, polls, running, sawRunning, finalFailures, elapsedMs: Date.now() - startedAt, item: finalItem }, null, 2) + '\n')
    if ((sawRunning && !running) || finalFailures > baselineFailures) break
  }
  await page.waitForTimeout(5000)
  await page.screenshot({ path: path.join(outputDir, 'live-06-followup-final.png'), fullPage: true })
  const bodyText = await page.locator('body').innerText()
  const host = await call('dsh-super-agent-mode/projection', { sessionId: state.sessionId })
  await writeFile(path.join(outputDir, 'live-followup-final-dom.json'), JSON.stringify({ bodyText }, null, 2) + '\n')
  await writeFile(path.join(outputDir, 'host-projection-after-followup.json'), JSON.stringify(host, null, 2) + '\n')
  await writeFile(path.join(outputDir, 'live-session.json'), JSON.stringify({ ...state, phase: 'followup-finished', followupElapsedMs: Date.now() - startedAt }, null, 2) + '\n')
  await writeFile(path.join(outputDir, 'live-followup-run.json'), JSON.stringify({ sessionId: state.sessionId, sawRunning, finalRunning: finalItem?.running, finalItem, baselineFailures, finalFailures, elapsedMs: Date.now() - startedAt, timedOut: Date.now() >= deadline, fatalError }, null, 2) + '\n')
} catch (error) {
  fatalError = error instanceof Error ? error.message : String(error)
  await writeFile(path.join(outputDir, 'live-followup-run.json'), JSON.stringify({ sessionId: state.sessionId, sawRunning, finalItem, baselineFailures, finalFailures, fatalError }, null, 2) + '\n')
  await page.screenshot({ path: path.join(outputDir, 'live-followup-error.png'), fullPage: true }).catch(() => {})
} finally {
  await writeFile(path.join(outputDir, 'live-followup-observations.json'), JSON.stringify({ consoleEvents, pageErrors, badResponses, requestPaths, fatalError }, null, 2) + '\n')
  await browser.close()
}
if (fatalError) process.exitCode = 1