import type { ReactNode } from 'react'
import type { SessionRuntimeProps } from './SuperAgentPanel.tsx'
import { isSuperAgentPreset } from './projection.ts'

export interface SuperAgentEntryProps extends SessionRuntimeProps {
  openPanel(): void
}

/** Session-scoped composer/footer entry; no global/primary tab is contributed. */
export function SuperAgentEntry(props: SuperAgentEntryProps): ReactNode {
  let preset: unknown
  try {
    preset = props.useProjection?.('agentPreset')
  } catch {
    return null
  }
  if (!isSuperAgentPreset(preset)) return null
  return (
    <button type="button" className="sam-entry" onClick={props.openPanel} aria-label="打开 Super Agent 会话监管面板">
      <span aria-hidden="true">◎</span>
      <span>Super Agent 监管</span>
    </button>
  )
}
