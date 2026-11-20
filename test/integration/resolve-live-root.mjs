import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'
const target = process.env.DSH_TEST_URL
const outputDir = path.resolve(process.env.DSH_VALIDATION_DIR)
const ids = (process.env.DSH_TEST_SESSION_IDS || '').split(',').map(value => value.trim()).filter(Boolean)
const token = new URL(target).searchParams.get('token')
const redact = value => token ? String(value).split(token).join('[REDACTED]') : String(value)
await mkdir(outputDir, { recursive: true })
const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true })
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(redact(error.message)))
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(8000)
  const results = []
  for (const sessionId of ids) {
    const result = await page.evaluate(async sessionId => {
      const response = await fetch('api/dsh-super-agent-mode/projection', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'dsh-super-agent-mode/projection', payload: { sessionId } }),
      })
      return { httpStatus: response.status, body: await response.json() }
    }, sessionId)
    results.push({ sessionId, ...result })
  }
  await writeFile(path.join(outputDir, 'root-resolution.json'), JSON.stringify({ results, errors }, null, 2) + '\n', 'utf8')
  console.log(JSON.stringify(results.map(entry => ({ sessionId: entry.sessionId, result: entry.body?.result })), null, 2))
} finally { await browser.close() }