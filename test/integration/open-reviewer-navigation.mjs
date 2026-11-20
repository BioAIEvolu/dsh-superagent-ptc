import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'
const target = process.env.DSH_TEST_URL
const outputDir = path.resolve(process.env.DSH_VALIDATION_DIR)
const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } })
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(10000)
  const title = 'SuperAgent PTC 真实路由有界验收'
  const search = page.getByPlaceholder('搜索会话名称')
  if (await search.isVisible().catch(() => false)) {
    await search.fill(title)
    await page.waitForTimeout(1200)
  }
  await page.getByText(title, { exact: true }).last().click()
  await page.waitForTimeout(7000)
  const subagents = page.getByText('2 个子智能体', { exact: true })
  let opened = false
  if (await subagents.isVisible().catch(() => false)) {
    await subagents.click()
    opened = true
    await page.waitForTimeout(2000)
  }
  let reviewerOpened = false
  const reviewerButton = page.getByRole('button', { name: '在侧边栏打开 独立standard只读Reviewer待命', exact: true })
  if (await reviewerButton.isVisible().catch(() => false)) {
    await reviewerButton.click()
    reviewerOpened = true
    await page.waitForTimeout(5000)
  }
  if (process.argv[2] === 'trace') {
    const traceTab = page.getByText('轨迹', { exact: true }).last()
    if (await traceTab.isVisible().catch(() => false)) {
      await traceTab.click()
      await page.waitForTimeout(5000)
    }
  }
  const interactive = await page.locator('button,[role="button"],[role="tab"],[role="menuitem"],a').evaluateAll(elements => elements.filter(element => {
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden'
  }).map(element => ({ text: (element.innerText || element.textContent || '').trim(), aria: element.getAttribute('aria-label'), title: element.getAttribute('title'), className: element.className })))
  const bodyText = await page.locator('body').innerText()
  await page.screenshot({ path: path.join(outputDir, 'reviewer-navigation.png'), fullPage: true })
  await writeFile(path.join(outputDir, 'reviewer-navigation.json'), JSON.stringify({ opened, reviewerOpened, interactive, bodyText }, null, 2) + '\n', 'utf8')
  console.log(JSON.stringify({ opened, interactive, bodyText: bodyText.slice(-7000) }, null, 2))
} finally { await browser.close() }
