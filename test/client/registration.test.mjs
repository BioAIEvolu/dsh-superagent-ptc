import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../../', import.meta.url)
const read = path => readFileSync(new URL(path, root), 'utf8')
const index = read('src/client/index.ts')
const panel = read('src/client/SuperAgentPanel.tsx')
const entry = read('src/client/SuperAgentEntry.tsx')
const routingPanel = read('src/client/RoutingPanel.tsx')

test('slot injection reuses the apply-lifetime readProjection reference', () => {
  assert.match(index, /const readProjection: ProjectionBridge\['read'\] = bridge\.read/)
  assert.match(index, /inject: \(\) => \(\{ readProjection \}\)/)
  assert.doesNotMatch(index, /readProjection:\s*\(/)
})

test('projection effect reruns only for stable reader, session change, or explicit reload', () => {
  assert.match(panel, /props\.readProjection\(props\.sessionId, controller\.signal\)/)
  assert.match(panel, /\}, \[props\.readProjection, props\.sessionId, reload\]\)/)
  assert.match(panel, /onClick=\{\(\) => setReload\(value => value \+ 1\)\}/)
})

test('registration keeps the verified right-sidebar and string-preset contract', () => {
  assert.match(index, /ctx\.sidebarRightTabs\.register\(/)
  assert.match(index, /ctx\.slots\.inject\('sidebar\.right\.pane\.tab'/)
  assert.match(index, /key: TAB_ID/)
  assert.match(index, /ctx\.sidebarRight\.openTabIn\(sessionId, TAB_KIND\)/)
  assert.doesNotMatch(index, /conversation\.view|guide:/)
  assert.match(panel, /projectionValue\(props\.useProjection, 'agentPreset'\)/)
  assert.match(panel, /!isSuperAgentPreset\(preset\)/)
  assert.match(entry, /props\.useProjection\?\.\('agentPreset'\)/)
  assert.match(entry, /!isSuperAgentPreset\(preset\)/)
})

test('routing section is wired to the real projection and keeps historical switch audits', () => {
  assert.ok(panel.includes('<RoutingSection projection={projection} />'))
  assert.ok(routingPanel.includes('projection.run?.modelPolicy'))
  assert.ok(routingPanel.includes('projection.routeFailures ?? []'))
  assert.ok(routingPanel.includes('projection.mandates.flatMap'))
  assert.match(routingPanel, /data-routing-empty/)
  assert.match(routingPanel, /readMandateRoute/)
  assert.doesNotMatch(routingPanel, /fixtures|mock|demo|tokenUsage/)
})

test('composer dock entry is removed by user decision; footer remains the openPanel entry', () => {
  assert.doesNotMatch(index, /conversation\.input\.dock/)
  assert.doesNotMatch(index, /super-agent:composer-dock/)
  assert.match(index, /ctx\.slots\.inject\('conversation\.session\.header\.actions\.subagent\.footer'/)
  assert.match(index, /openTabIn\(sessionId, TAB_KIND\)/)
})
