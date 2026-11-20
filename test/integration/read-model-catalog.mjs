import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'

const target = process.env.DSH_TEST_URL
if (!target) throw new Error('DSH_TEST_URL is required')
const output = path.resolve(process.env.DSH_CATALOG_OUTPUT || ''.validation/live'/model-catalog-routes.json')
const browser = await chromium.launch({
  executablePath: process.env.DSH_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
})
try {
  const page = await browser.newPage()
  const responsePromise = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/session/modelCatalog' && response.request().method() === 'POST',
  { timeout: 45000 })
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 })
  const response = await responsePromise
  const envelope = await response.json()
  const value = envelope?.result?.value
  if (!envelope?.result?.ok || !value || !Array.isArray(value.groups) || !Array.isArray(value.routableProviders)) {
    throw new Error('modelCatalog returned no valid catalog')
  }
  const routes = value.groups.flatMap(group => (Array.isArray(group.models) ? group.models : []).map(model => ({
    provider: group.id,
    providerName: group.name,
    model: model.id,
    name: model.name,
    routable: value.routableProviders.includes(group.id),
  })))
  const report = {
    default: value.default ?? null,
    routableProviders: value.routableProviders,
    failures: value.failures ?? [],
    routes,
  }
  await mkdir(path.dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', 'utf8')
  console.log(JSON.stringify(report, null, 2))
} finally {
  await browser.close()
}
