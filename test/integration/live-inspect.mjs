import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'
const target = process.env.DSH_TEST_URL
const outputDir = path.resolve(process.env.DSH_VALIDATION_DIR || '.validation/live')
const label = process.argv[2] || 'inspect'
const token = new URL(target).searchParams.get('token')
const redact = value => token ? String(value).split(token).join('[REDACTED]') : String(value)
const state = JSON.parse(await readFile(path.join(outputDir, 'live-session.json'), 'utf8'))
const browser = await chromium.launch({ executablePath: process.env.DSH_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true })
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } })
const paths = []
const errors = []
page.on('request', request => { try { paths.push({ method: request.method(), path: new URL(request.url()).pathname }) } catch {} })
page.on('pageerror', error => errors.push(redact(error.message)))
await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(10000)
const close = page.getByRole('button', { name: '关闭', exact: true })
if (await close.isVisible().catch(() => false)) await close.click()
const title = state.title || '这是独立 super-agent-live 测试会'
let sessionButton = page.getByRole('button', { name: title, exact: true })
if (!await sessionButton.isVisible().catch(() => false)) {
  const search = page.getByPlaceholder('搜索会话名称')
  if (await search.isVisible().catch(() => false)) {
    await search.fill(title)
    await page.waitForTimeout(1000)
    sessionButton = page.getByRole('button', { name: title, exact: true })
  }
}
let clicked = false
if (await sessionButton.isVisible().catch(() => false)) {
  await sessionButton.click()
  clicked = true
  await page.waitForTimeout(7000)
} else {
  const workspaceText = page.getByText(title, { exact: true }).first()
  if (await workspaceText.isVisible().catch(() => false)) {
    await workspaceText.click()
    await page.waitForTimeout(2500)
    sessionButton = page.getByRole('button', { name: title, exact: true }).last()
    if (await sessionButton.isVisible().catch(() => false)) {
      await sessionButton.click()
      clicked = true
      await page.waitForTimeout(7000)
    } else {
      const sessionText = page.getByText(title, { exact: true }).last()
      if (await sessionText.isVisible().catch(() => false)) {
        await sessionText.click()
        clicked = true
        await page.waitForTimeout(7000)
      }
    }
  }
}
const call = async (endpoint, payload) => page.evaluate(async ({ endpoint, payload }) => {
  const response = await fetch('api/' + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: endpoint, payload }) })
  return { httpStatus: response.status, body: await response.json() }
}, { endpoint, payload })
if (label === 'trace') {
  const traceTab = page.getByText('轨迹', { exact: true }).first()
  if (await traceTab.isVisible().catch(() => false)) {
    await traceTab.click()
    await page.waitForTimeout(5000)
  }
}
if (label === 'final-panel') {
  const entry = page.getByRole('button', { name: '打开 Super Agent 会话监管面板', exact: true })
  if (await entry.isVisible().catch(() => false)) {
    await entry.click()
    await page.waitForTimeout(6000)
  }
}
const host = state.sessionId ? await call('dsh-super-agent-mode/projection', { sessionId: state.sessionId }) : null
if (label === 'model-menu' || label === 'model-list') {
  const modelTrigger = page.getByRole('button', { name: /选择模型，当前/ })
  if (await modelTrigger.isVisible().catch(() => false)) {
    await modelTrigger.click()
    await page.waitForTimeout(1500)
  }
  if (label === 'model-list') {
    const currentModel = page.getByText('DeepSeek-V4.1-Flash', { exact: true }).last()
    if (await currentModel.isVisible().catch(() => false)) {
      await currentModel.click()
      await page.waitForTimeout(1500)
    }
  }
}
const bodyText = await page.locator('body').innerText()
await page.screenshot({ path: path.join(outputDir, 'live-' + label + '.png'), fullPage: true })
await writeFile(path.join(outputDir, 'live-' + label + '.json'), JSON.stringify({ clicked, title, bodyText, host, paths, errors }, null, 2) + '\n', 'utf8')
console.log(JSON.stringify({ clicked, title, bodyText: bodyText.slice(-12000), host: host?.body?.result, errors }, null, 2))
await browser.close()