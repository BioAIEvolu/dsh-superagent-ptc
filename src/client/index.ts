import { SuperAgentEntry } from './SuperAgentEntry.tsx'
import { SuperAgentPanel } from './SuperAgentPanel.tsx'
import { createProjectionBridge, unavailableProjectionBridge, type ProjectionBridge } from './rpc.ts'
import { superAgentStyles } from './styles.ts'

export const inject = ['slots', 'connection', 'sidebarRight', 'sidebarRightTabs']

const TAB_ID = 'dsh-super-agent-mode'
const TAB_KIND = 'super-agent'

interface ClientContext {
  effect(effect: () => unknown, label: string): unknown
  get(name: string): unknown
  slots?: SlotsFace
  sidebarRightTabs?: SidebarRightTabsFace
  sidebarRight?: SidebarRightFace
}

/** Structural narrowing avoids the unrelated hoisted 0.2.0 slots declarations. */
interface SlotsFace {
  inject(name: string, register: () => unknown): unknown
  register(spec: Record<string, unknown>, component: unknown): () => void
}

interface SidebarRightTabsFace {
  register(definition: {
    id: string
    kind: string
    title: () => string
    keepMounted?: boolean
  }): () => void
}

interface SidebarRightFace {
  openTabIn(sessionId: string, kind: string): unknown
}

function hasSlots(ctx: ClientContext): ctx is ClientContext & { slots: SlotsFace } {
  const slots = ctx.slots
  return typeof slots === 'object' && slots !== null && typeof slots.inject === 'function' && typeof slots.register === 'function'
}

function hasTabRegistry(ctx: ClientContext): ctx is ClientContext & { sidebarRightTabs: SidebarRightTabsFace } {
  return typeof ctx.sidebarRightTabs?.register === 'function'
}

function hasSidebarRight(ctx: ClientContext): ctx is ClientContext & { sidebarRight: SidebarRightFace } {
  return typeof ctx.sidebarRight?.openTabIn === 'function'
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.setAttribute('data-plugin', 'dsh-superagent-ptc')
    style.textContent = superAgentStyles
    document.head.appendChild(style)
    return () => style.remove()
  }, 'super-agent:client-css')

  let bridge: ProjectionBridge
  try {
    bridge = createProjectionBridge(ctx.get('connection'))
  } catch {
    bridge = unavailableProjectionBridge('connection.rpc.call 不可用')
  }

  // Stable for the whole apply lifetime: slot re-rendering must not retrigger the panel effect.
  const readProjection: ProjectionBridge['read'] = bridge.read

  if (!hasTabRegistry(ctx) || !hasSlots(ctx)) return

  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: TAB_KIND,
    title: () => 'SuperAgent PTC',
    keepMounted: false,
  }), 'super-agent:tab-type')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: TAB_ID,
    inject: () => ({ readProjection }),
  }, SuperAgentPanel)), 'super-agent:tab-body')

  if (hasSidebarRight(ctx)) {
    const injectEntry = (sessionId: string) => ({
      openPanel: () => ctx.sidebarRight.openTabIn(sessionId, TAB_KIND),
    })
    ctx.effect(() => ctx.slots.inject('conversation.session.header.actions.subagent.footer', () => ctx.slots.register({
      name: 'conversation.session.header.actions.subagent.footer',
      id: 'dsh-super-agent-mode',
      inject: injectEntry,
    }, SuperAgentEntry)), 'super-agent:subagent-footer')
  }
}
