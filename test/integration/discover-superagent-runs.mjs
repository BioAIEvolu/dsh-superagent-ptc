import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'
const target = process.env.DSH_TEST_URL
const output = path.resolve(process.env.DSH_VALIDATION_DIR)
const token = new URL(target).searchParams.get('token')
const redact = value => token ? String(value).split(token).join('[REDACTED]') : String(value)
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true })
try {
  const page = await browser.newPage()
  let listPayload = null
  const errors = []
  page.on('pageerror', error => errors.push(redact(error.message)))
  page.on('request', request => {
    try {
      if (new URL(request.url()).pathname === '/api/session/list' && request.postData()) listPayload = JSON.parse(request.postData()).payload
    } catch {}
  })
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(10000)
  if (!listPayload) throw new Error('No session/list request payload observed')
  const call = async (endpoint, payload) => page.evaluate(async ({ endpoint, payload }) => {
    const response = await fetch('api/' + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: endpoint, payload }) })
    return { httpStatus: response.status, body: await response.json() }
  }, { endpoint, payload })
  const listed = await call('session/list', listPayload)
  const items = listed.body?.result?.value?.items || []
  const candidates = items.filter(item => item.projections?.values?.agentPreset === 'super-agent' && item.agentAvailable)
  const discoveries = []
  for (const item of candidates) {
    const projection = await call('dsh-super-agent-mode/projection', { sessionId: item.sessionId })
    const value = projection.body?.result?.value
    discoveries.push({ sessionId: item.sessionId, title: item.projections?.values?.title || null, blank: item.blank, running: item.running, projection })
  }
  const summary = discoveries.map(entry => ({
    sessionId: entry.sessionId, title: entry.title, blank: entry.blank, running: entry.running,
    ok: entry.projection.body?.result?.ok,
    error: entry.projection.body?.result?.error,
    runId: entry.projection.body?.result?.value?.run?.id,
    revision: entry.projection.body?.result?.value?.run?.revision,
    generation: entry.projection.body?.result?.value?.run?.generation,
    recovery: entry.projection.body?.result?.value?.recovery,
    workItems: entry.projection.body?.result?.value?.workItems?.map(item => ({ id: item.id, status: item.status, attempt: item.attempt })),
    proof: entry.projection.body?.result?.value?.proof,
  }))
  await writeFile(path.join(output, 'current-root-discovery.json'), JSON.stringify({ summary, discoveries, errors }, null, 2) + '\n', 'utf8')
  console.log(JSON.stringify(summary, null, 2))
} finally { await browser.close() }
