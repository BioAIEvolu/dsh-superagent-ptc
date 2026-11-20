import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const target = process.env.DSH_TEST_URL
if (!target) throw new Error('DSH_TEST_URL is required')
const parsedTarget = new URL(target)
const suppliedToken = parsedTarget.searchParams.get('token')
const here = path.dirname(fileURLToPath(import.meta.url))
const workspace = path.resolve(here, '../../..')
const outputDir = path.resolve(process.env.DSH_VALIDATION_DIR || path.join(workspace, '.validation/rc5'))
const chromePath = process.env.DSH_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const exploreOnly = process.env.DSH_EXPLORE_ONLY === '1'

function safeUrl(value) {
  try {
    const url = new URL(value)
    if (url.pathname === '/plugins/' && url.search) {
      const query = [...url.searchParams.entries()]
        .filter(([key]) => !/token|secret|password|credential|api.?key|authorization|cookie/i.test(key))
        .map(([key, item]) => key + '=' + redact(item))
        .join('&')
      return url.pathname + (query ? '?' + query : '')
    }
    return url.pathname
  } catch {
    return redact(String(value))
  }
}

function redact(value) {
  let text = String(value)
  if (suppliedToken) text = text.split(suppliedToken).join('[REDACTED]')
  return text
    .replace(/([?&](?:token|access_token|api_key|key)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/https?:\/\/[^\s"'<>]+/g, match => safeUrl(match))
}

function clean(value) {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map(clean)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)]))
  }
  return value
}

async function evidence(name, value) {
  await writeFile(path.join(outputDir, name), JSON.stringify(clean(value), null, 2) + '\n', 'utf8')
}

async function snapshot(page) {
  return page.evaluate(() => {
    const interactive = [...document.querySelectorAll('button, [role="button"], [role="tab"], [role="combobox"], select, input, textarea, [contenteditable="true"], a')]
      .filter(element => {
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
      })
      .map((element, index) => ({
        index,
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role'),
        text: (element.innerText || element.textContent || '').trim().slice(0, 500),
        ariaLabel: element.getAttribute('aria-label'),
        title: element.getAttribute('title'),
        placeholder: element.getAttribute('placeholder'),
        testId: element.getAttribute('data-testid'),
        id: element.id || undefined,
        className: typeof element.className === 'string' ? element.className.slice(0, 300) : undefined,
        disabled: element.matches(':disabled'),
        expanded: element.getAttribute('aria-expanded'),
        selected: element.getAttribute('aria-selected'),
        checked: element.getAttribute('aria-checked'),
      }))
    return {
      title: document.title,
      bodyText: (document.body?.innerText || '').slice(0, 60000),
      interactive,
      plugin: {
        styles: document.querySelectorAll('style[data-plugin="dsh-superagent-ptc"]').length,
        panels: document.querySelectorAll('.sam-panel').length,
        entries: document.querySelectorAll('.sam-entry').length,
        presetPanels: document.querySelectorAll('[data-agent-preset="super-agent"]').length,
      },
    }
  })
}

await mkdir(outputDir, { recursive: true })
const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--disable-dev-shm-usage'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })
const page = await context.newPage()
const consoleEvents = []
const pageErrors = []
const requests = []
const failures = []
const badResponses = []
const websockets = []
const apiObservations = []
const pendingResponses = []
function sanitizeApi(value, key = '') {
  if (/token|secret|password|credential|api.?key|authorization|cookie/i.test(key)) return '[REDACTED]'
  if (Array.isArray(value)) return value.map(item => sanitizeApi(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [childKey, sanitizeApi(item, childKey)]))
  }
  return value
}
page.on('console', message => consoleEvents.push({ type: message.type(), text: redact(message.text()) }))
page.on('pageerror', error => pageErrors.push({ message: redact(error.message) }))
page.on('request', request => {
  const pathname = new URL(request.url()).pathname
  const record = { method: request.method(), url: safeUrl(request.url()), resourceType: request.resourceType() }
  if (['/api/agentPresets/select', '/api/session/create', '/api/session/projections', '/api/dsh-super-agent-mode/projection', '/api'].includes(pathname)) {
    const raw = request.postData()
    if (raw) {
      try { record.body = sanitizeApi(JSON.parse(raw)) } catch { record.body = redact(raw) }
    }
  }
  requests.push(record)
})
page.on('requestfailed', request => failures.push({ method: request.method(), url: safeUrl(request.url()), error: redact(request.failure()?.errorText || 'unknown') }))
page.on('response', response => {
  const pathname = safeUrl(response.url())
  if (response.status() >= 400) badResponses.push({ status: response.status(), url: pathname })
  if (['/api/agentPresets/list', '/api/agentPresets/select', '/api/session/create', '/api/session/projections', '/api/session/list', '/api/session/modelCatalog', '/api/dynamicCordisRunner/inventory', '/api/dynamicCordisRunner/syncInspectManifest', '/api/dsh-super-agent-mode/projection', '/api'].includes(pathname)) {
    const pending = response.json().then(body => {
      apiObservations.push({ status: response.status(), endpoint: pathname, body: sanitizeApi(body) })
    }).catch(error => {
      apiObservations.push({ status: response.status(), endpoint: pathname, parseError: redact(String(error)) })
    })
    pendingResponses.push(pending)
  }
})
page.on('websocket', socket => {
  websockets.push({ event: 'open', url: safeUrl(socket.url()) })
  socket.on('close', () => websockets.push({ event: 'close', url: safeUrl(socket.url()) }))
  socket.on('socketerror', error => websockets.push({ event: 'error', url: safeUrl(socket.url()), error: redact(String(error)) }))
})

let navigationError = null
try {
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(12000)
} catch (error) {
  navigationError = redact(error instanceof Error ? error.message : String(error))
}
await page.screenshot({ path: path.join(outputDir, '01-loaded.png'), fullPage: true })
const initial = await snapshot(page)
await evidence('dom-initial.json', initial)

let presetMenu = null
let afterContinue = null
if (navigationError === null) {
  const continueButton = page.getByRole('button', { name: '继续', exact: true })
  if (await continueButton.isVisible().catch(() => false)) {
    await continueButton.click()
    await page.waitForTimeout(1500)
  }
  afterContinue = await snapshot(page)
  await page.screenshot({ path: path.join(outputDir, '01b-after-continue.png'), fullPage: true })
  await evidence('dom-after-continue.json', afterContinue)
  if (!exploreOnly) {
    const closeButton = page.getByRole('button', { name: '关闭', exact: true })
    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click({ timeout: 5000 })
      await page.waitForTimeout(750)
    }
    const newSession = page.getByRole('button', { name: '新建会话', exact: true }).last()
    if (await newSession.isVisible().catch(() => false)) {
      await newSession.click({ timeout: 5000 })
      await page.waitForTimeout(1500)
    }
    const presetTrigger = page.getByTitle('选择新任务使用的 Agent 预设')
    if (await presetTrigger.isVisible().catch(() => false)) {
      await presetTrigger.click({ timeout: 5000 })
      await page.waitForTimeout(750)
      await page.screenshot({ path: path.join(outputDir, '02-preset-menu.png'), fullPage: true })
      presetMenu = await snapshot(page)
      await evidence('dom-preset-menu.json', presetMenu)
      const superAgentItem = page.getByRole('menuitem').filter({ hasText: 'SuperAgent PTC' })
      if (await superAgentItem.isVisible().catch(() => false)) {
        await superAgentItem.click({ timeout: 5000 })
        await page.waitForTimeout(10000)
        await page.screenshot({ path: path.join(outputDir, '03-preset-selected.png'), fullPage: true })
        const selected = await snapshot(page)
        const runtime = await page.evaluate(() => {
          const presetCandidates = []
          const visit = (value, path) => {
            if (!value || typeof value !== 'object') return
            for (const [key, child] of Object.entries(value)) {
              const childPath = path + '.' + key
              if (/agentPreset/i.test(key) || child === 'super-agent') presetCandidates.push({ path: childPath, value: child })
              if (child && typeof child === 'object') visit(child, childPath)
            }
          }
          for (const key of Object.keys(localStorage)) {
            if (!key.startsWith('dsh.conversation.') && key !== 'dsh.sessions.current') continue
            try {
              const value = JSON.parse(localStorage.getItem(key))
              visit(value, key)
            } catch {}
          }
          return {
            globalKeys: Object.keys(window).filter(key => /dsh|cordis|plugin|session|preset/i.test(key)).sort(),
            bootKeys: window.__DSH_BOOT__ && typeof window.__DSH_BOOT__ === 'object' ? Object.keys(window.__DSH_BOOT__).sort() : [],
            localStorageKeys: Object.keys(localStorage).sort(),
            sessionStorageKeys: Object.keys(sessionStorage).sort(),
            presetCandidates,
          }
        })
        await evidence('dom-preset-selected.json', { ...selected, runtime })
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
        await page.waitForTimeout(12000)
        const closeAfterReload = page.getByRole('button', { name: '关闭', exact: true })
        if (await closeAfterReload.isVisible().catch(() => false)) {
          await closeAfterReload.click({ timeout: 5000 })
          await page.waitForTimeout(750)
        }
        await page.screenshot({ path: path.join(outputDir, '04-reloaded.png'), fullPage: true })
        const reloaded = await snapshot(page)
        await evidence('dom-reloaded.json', reloaded)
        const openRight = page.getByRole('button', { name: '打开右侧边栏', exact: true })
        if (await openRight.isVisible().catch(() => false)) {
          await openRight.click({ timeout: 5000 })
          await page.waitForTimeout(5000)
          await page.screenshot({ path: path.join(outputDir, '05-right-sidebar.png'), fullPage: true })
          const rightSidebar = await snapshot(page)
          await evidence('dom-right-sidebar.json', rightSidebar)
          const moreTools = page.getByRole('button', { name: '更多工具', exact: true })
          if (await moreTools.isVisible().catch(() => false)) {
            await moreTools.click({ timeout: 5000 })
            await page.waitForTimeout(1000)
            await page.screenshot({ path: path.join(outputDir, '05b-more-tools.png'), fullPage: true })
            await evidence('dom-more-tools.json', await snapshot(page))
            await moreTools.click({ timeout: 5000 }).catch(() => page.keyboard.press('Escape'))
          }
          let entry = page.getByRole('button', { name: '打开 Super Agent 会话监管面板', exact: true })
          let entryCount = await entry.count()
          let entryVisible = entryCount > 0 && await entry.first().isVisible().catch(() => false)
          if (entryCount > 0 && !entryVisible) {
            const subagentTrigger = page.getByRole('button', { name: /子智能体|subagent/i }).last()
            if (await subagentTrigger.isVisible().catch(() => false)) {
              await subagentTrigger.click({ timeout: 5000 })
              await page.waitForTimeout(1000)
            }
            entry = page.getByRole('button', { name: '打开 Super Agent 会话监管面板', exact: true })
            entryCount = await entry.count()
            entryVisible = entryCount > 0 && await entry.first().isVisible().catch(() => false)
          }
          const footerState = await snapshot(page)
          await evidence('dom-subagent-footer.json', { ...footerState, entryCount, entryVisible })
          if (entryVisible) {
            await page.screenshot({ path: path.join(outputDir, '05c-subagent-footer.png'), fullPage: true })
            await entry.first().click({ timeout: 5000 })
            await page.waitForTimeout(6000)
            await page.screenshot({ path: path.join(outputDir, '05d-super-agent-panel.png'), fullPage: true })
            const panelState = await snapshot(page)
            const panelUi = await page.evaluate(() => ({
              panels: document.querySelectorAll('.sam-panel').length,
              unavailableAlerts: document.querySelectorAll('.sam-alert[data-status="unavailable"]').length,
              emptyRun: document.querySelector('[data-empty="run"]')?.textContent || null,
              observedAt: document.querySelector('.sam-observed')?.textContent || null,
            }))
            await evidence('dom-super-agent-panel.json', { ...panelState, entryCount, entryVisible, panelUi })
          } else {
            await evidence('dom-super-agent-panel.json', {
              status: 'unavailable',
              reason: 'Super Agent footer entry was not visible',
              entryCount,
              entryVisible,
              plugin: footerState.plugin,
            })
          }
        }
        await Promise.all(pendingResponses)
        const selectedCreation = apiObservations.findLast(entry =>
          entry.endpoint === '/api/session/create'
          && entry.body?.result?.value?.agentPreset === 'super-agent'
          && typeof entry.body?.result?.value?.sessionId === 'string')
        const selectedSessionId = selectedCreation?.body?.result?.value?.sessionId
        if (selectedSessionId) {
          const hostRpc = await page.evaluate(async sessionId => {
            const rpcId = crypto.randomUUID()
            try {
              const response = await fetch('api/dsh-super-agent-mode/projection', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  type: 'client-request',
                  rpcId,
                  method: 'dsh-super-agent-mode/projection',
                  payload: { sessionId },
                }),
              })
              return { httpStatus: response.status, body: await response.json() }
            } catch (error) {
              return { transportError: error instanceof Error ? error.message : String(error) }
            }
          }, selectedSessionId)
          const projection = hostRpc.body?.result?.value
          await evidence('host-projection-rpc.json', {
            ...hostRpc,
            validation: {
              expectedSessionId: selectedSessionId,
              transportOk: hostRpc.httpStatus === 200 && hostRpc.body?.rpcId !== undefined,
              rpcOk: hostRpc.body?.result?.ok === true,
              sessionMatches: projection?.sessionId === selectedSessionId,
              agentPreset: projection?.agentPreset,
              schemaVersion: projection?.schemaVersion,
              run: projection?.run,
            },
          })
        } else {
          await evidence('host-projection-rpc.json', { status: 'unknown', reason: 'No selected blank session ID observed' })
        }
        const closeRightForIsolation = page.getByRole('button', { name: '收起右侧边栏', exact: true })
        if (await closeRightForIsolation.isVisible().catch(() => false)) {
          await closeRightForIsolation.click({ timeout: 5000 })
          await page.waitForTimeout(750)
        }
        for (const preset of [
          { id: 'standard', label: '标准模式', slug: 'standard', screenshot: '08-standard.png' },
          { id: 'ptc', label: 'PTC 模式', slug: 'ptc', screenshot: '09-ptc.png' },
        ]) {
          const trigger = page.getByTitle('选择新任务使用的 Agent 预设')
          if (await trigger.isVisible().catch(() => false)) {
            await trigger.click({ timeout: 5000 })
            const item = page.getByRole('menuitem', { name: new RegExp('^' + preset.label) })
            await item.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
            if (await item.isVisible().catch(() => false)) {
              await item.click({ timeout: 5000 })
              await page.waitForTimeout(5000)
              const isolation = await page.evaluate(() => ({
                presetLabel: document.querySelector('[title="选择新任务使用的 Agent 预设"]')?.textContent?.trim() || null,
                styles: document.querySelectorAll('style[data-plugin="dsh-superagent-ptc"]').length,
                entries: document.querySelectorAll('.sam-entry').length,
                panels: document.querySelectorAll('.sam-panel').length,
                visibleEntries: [...document.querySelectorAll('.sam-entry')].filter(element => {
                  const rect = element.getBoundingClientRect()
                  return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden'
                }).length,
              }))
              await page.screenshot({ path: path.join(outputDir, preset.screenshot), fullPage: true })
              await evidence('dom-preset-' + preset.slug + '.json', { ...await snapshot(page), expectedPreset: preset.id, isolation })
            } else {
              await page.screenshot({ path: path.join(outputDir, 'debug-' + preset.slug + '-menu.png'), fullPage: true })
              await evidence('dom-preset-' + preset.slug + '.json', {
                expectedPreset: preset.id,
                status: 'unknown',
                reason: 'Preset menu item not visible',
                menuState: await snapshot(page),
              })
            }
          } else {
            await evidence('dom-preset-' + preset.slug + '.json', { expectedPreset: preset.id, status: 'unknown', reason: 'Preset trigger not visible' })
          }
        }
        const pluginsButton = page.getByRole('button', { name: '插件', exact: true })
        if (await pluginsButton.isVisible().catch(() => false)) {
          await pluginsButton.click({ timeout: 5000 })
          await page.waitForTimeout(6000)
          await page.screenshot({ path: path.join(outputDir, '06-plugins.png'), fullPage: true })
          const plugins = await snapshot(page)
          await evidence('dom-plugins.json', plugins)
          const viewPlugin = page.getByRole('button', { name: '查看 dsh-superagent-ptc', exact: true })
          if (await viewPlugin.isVisible().catch(() => false)) {
            await viewPlugin.click({ timeout: 5000 })
            await page.waitForTimeout(2000)
            await page.screenshot({ path: path.join(outputDir, '07-plugin-detail.png'), fullPage: true })
            await evidence('dom-plugin-detail.json', await snapshot(page))
          }
        }
      }
    }
  }
}
await Promise.all(pendingResponses)
await evidence('runtime-observations.json', {
  navigationError,
  exploreOnly,
  browser: await browser.version(),
  apiObservations,
  consoleEvents,
  pageErrors,
  requests,
  failures,
  badResponses,
  websockets,
})
console.log(JSON.stringify(clean({ navigationError, exploreOnly, title: initial.title, initialBody: initial.bodyText.slice(0, 4000), afterContinue: afterContinue ? { bodyText: afterContinue.bodyText.slice(0, 12000), interactive: afterContinue.interactive, plugin: afterContinue.plugin } : null, presetMenu: presetMenu ? { bodyText: presetMenu.bodyText.slice(0, 12000), interactive: presetMenu.interactive, plugin: presetMenu.plugin } : null, consoleEvents, pageErrors, failures, badResponses }), null, 2))
await browser.close()