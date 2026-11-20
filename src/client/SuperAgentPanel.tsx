import { useEffect, useState, type ReactNode } from 'react'
import type { ProjectionBridge, ProjectionResult } from './rpc.ts'
import { RoutingSection } from './RoutingPanel.tsx'
import { formatModelRoute } from './routing.ts'
import {
  collectBlockingReasons,
  evidenceStatusMeta,
  explainBlockReason,
  memberActivityLabel,
  mergeMembers,
  readNativeGoal,
  resolveTeamMode,
  runStatusMeta,
  isSuperAgentPreset,
  workStatusMeta,
  type MemberView,
  type SuperAgentProjection,
  type WorkItemDto,
} from './projection.ts'

export interface SessionsProjectionState {
  projectionsBySession?: Record<string, { values?: { subagentCatalog?: unknown } } | undefined>
}

export interface SessionRuntimeProps {
  sessionId: string
  useProjection?: (key: string) => unknown
  useSessions?: <T>(selector: (state: SessionsProjectionState) => T) => T
}

export interface SuperAgentPanelProps extends SessionRuntimeProps {
  readProjection: ProjectionBridge['read']
}

function projectionValue(useProjection: SessionRuntimeProps['useProjection'], key: string): unknown {
  if (useProjection === undefined) return undefined
  try {
    return useProjection(key)
  } catch {
    return undefined
  }
}

function catalogValue(props: SessionRuntimeProps): unknown {
  if (props.useSessions === undefined) return undefined
  try {
    return props.useSessions(state => state.projectionsBySession?.[props.sessionId]?.values?.subagentCatalog)
  } catch {
    return undefined
  }
}

/** The whole contribution disappears outside the selected preset. */
export function SuperAgentPanel(props: SuperAgentPanelProps): ReactNode {
  const preset = projectionValue(props.useProjection, 'agentPreset')
  if (!isSuperAgentPreset(preset)) return null
  return <SuperAgentContent {...props} />
}

function SuperAgentContent(props: SuperAgentPanelProps): ReactNode {
  const nativeGoalValue = projectionValue(props.useProjection, 'goal')
  const nativeTeamValue = projectionValue(props.useProjection, 'agentTeam')
  const nativeCatalog = catalogValue(props)
  const [result, setResult] = useState<ProjectionResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setLoading(true)
    void props.readProjection(props.sessionId, controller.signal).then(next => {
      if (!active) return
      // A failed refresh clears the previous host snapshot: stale accepted is not accepted now.
      setResult(next)
      setLoading(false)
    })
    return () => {
      active = false
      controller.abort()
    }
  }, [props.readProjection, props.sessionId, reload])

  const projection = result?.status === 'ready' ? result.projection : null
  let nativeGoal = null
  try {
    nativeGoal = readNativeGoal(nativeGoalValue)
  } catch {
    nativeGoal = null
  }
  const nativeTeam = typeof nativeTeamValue === 'object' && nativeTeamValue !== null
    ? nativeTeamValue as { enabled?: unknown; tasks?: unknown; failure?: unknown }
    : undefined
  const teamMode = resolveTeamMode(nativeTeam?.enabled, projection?.teamEnabled)
  const members = mergeMembers(nativeCatalog, projection?.subagentCatalog ?? [])
  const blockingReasons = projection === null ? [] : collectBlockingReasons(projection, nativeGoal)

  return (
    <section className="sam-panel" data-agent-preset="super-agent" aria-label="Super Agent 会话监管">
      <header className="sam-header">
        <div>
          <h2>Super Agent</h2>
          <p>目标、义务、证据与独立验收</p>
        </div>
        <button
          type="button"
          className="sam-refresh"
          disabled={loading}
          onClick={() => setReload(value => value + 1)}
          aria-label={loading ? '正在读取宿主投影' : '刷新宿主投影'}
        >
          {loading ? '读取中…' : '刷新'}
        </button>
      </header>

      {loading && result === null && <p className="sam-empty" role="status">正在读取真实宿主投影…</p>}
      {result?.status === 'unavailable' && (
        <div className="sam-alert" role="alert" data-status="unavailable">
          <strong>? 宿主投影 unavailable</strong>
          <p>无法确认监管状态，不会沿用旧的成功结论。</p>
          <code>{result.code}</code>
          <p>{result.message}</p>
        </div>
      )}

      <GoalCard projection={projection} nativeGoal={nativeGoal} />
      <TeamCard
        mode={teamMode}
        nativeFailure={nativeTeam?.failure}
        nativeTaskCount={Array.isArray(nativeTeam?.tasks) ? nativeTeam.tasks.length : undefined}
        host={projection}
      />

      {projection === null ? (
        <section className="sam-section" aria-labelledby="sam-native-members">
          <SectionTitle id="sam-native-members" title="Worker / Reviewer" />
          <MemberList members={members} />
        </section>
      ) : (
        <>
          {projection.run === null && (
            <p className="sam-empty" data-empty="run">当前会话尚无监管 Run。不会生成演示数据。</p>
          )}
          {blockingReasons.length > 0 && (
            <section className="sam-section sam-blocked" aria-labelledby="sam-blocking">
              <SectionTitle id="sam-blocking" title="阻断原因" />
              <ul className="sam-list">{blockingReasons.map(reason => {
                const explanation = explainBlockReason(reason)
                return <li key={reason}><code>{reason}</code>{explanation !== reason ? <span className="sam-block-explain"> · {explanation}</span> : null}</li>
              })}</ul>
            </section>
          )}
          {projection.run !== null && (projection.run.status === 'blocked' || projection.run.status === 'needs_user') && blockingReasons.length === 0 && (
            <p className="sam-alert" role="alert">宿主未提供具体阻断原因，保持 unknown。</p>
          )}

          <RoutingSection projection={projection} />

          <section className="sam-section" aria-labelledby="sam-obligations">
            <SectionTitle id="sam-obligations" title="开放义务与禁止项" />
            <ObligationList projection={projection} />
          </section>

          <section className="sam-section" aria-labelledby="sam-agenda">
            <SectionTitle id="sam-agenda" title="议程 / attempt" />
            {projection.workItems.length === 0
              ? <p className="sam-empty">暂无议程。</p>
              : <ol className="sam-agenda">{projection.workItems.map(item => (
                  <WorkItemRow key={item.id} item={item} projection={projection} />
                ))}</ol>}
          </section>

          <section className="sam-section" aria-labelledby="sam-members">
            <SectionTitle id="sam-members" title="Worker / Reviewer · 原生目录" />
            <MemberList members={members} />
          </section>

          <section className="sam-section" aria-labelledby="sam-evidence">
            <SectionTitle id="sam-evidence" title="证据门" />
            {projection.evidence.length === 0
              ? <p className="sam-empty">暂无证据。缺失证据不等于 pass。</p>
              : <EvidenceList projection={projection} />}
          </section>

          <section className="sam-section" aria-labelledby="sam-audit">
            <SectionTitle id="sam-audit" title="审计时间线" />
            {projection.audit.length === 0
              ? <p className="sam-empty">暂无审计事件。</p>
              : <AuditTimeline projection={projection} />}
          </section>

          <footer className="sam-observed">
            Host 观察时间：{formatTime(projection.observedAt)} · schema v{projection.schemaVersion}
          </footer>
        </>
      )}
    </section>
  )
}

function GoalCard({ projection, nativeGoal }: {
  projection: SuperAgentProjection | null
  nativeGoal: ReturnType<typeof readNativeGoal>
}): ReactNode {
  const run = projection?.run ?? null
  const anchor = projection?.currentAnchor ?? null
  const objective = run?.objective ?? nativeGoal?.objective ?? projection?.goal?.objective
  const runMeta = run === null ? null : runStatusMeta(run.status)
  const activation = projection?.goal?.activation
  const goalPhase = nativeGoal?.phase ?? projection?.goal?.phase
  const goalRounds = nativeGoal?.roundsStarted ?? projection?.goal?.roundsStarted
  const goalAbsent = goalPhase === undefined && goalRounds === undefined
  return (
    <section className="sam-section sam-goal" aria-labelledby="sam-goal-title">
      <div className="sam-goal-heading">
        <SectionTitle id="sam-goal-title" title="目标 / Anchor" />
        {runMeta !== null && <Badge tone={runMeta.tone} icon={runMeta.icon} label={runMeta.label} />}
      </div>
      <p className="sam-objective">{objective ?? '目标未知：原生 goal 与 host Run 均未提供。'}</p>
      <dl className="sam-facts">
        <div><dt>Anchor version</dt><dd>{anchor === null ? '未知' : 'v' + anchor.version}</dd></div>
        <div><dt>Run revision</dt><dd>{run === null ? '未知' : run.revision}</dd></div>
        <div><dt>Goal phase</dt><dd>{goalAbsent ? '未绑定' : goalPhase ?? '未知'}</dd></div>
        <div><dt>Goal 轮次</dt><dd>{goalAbsent ? '未绑定' : goalRounds ?? '未知'}</dd></div>
      </dl>
      {goalAbsent && <p className="sam-note" data-goal="unbound">本会话未创建 DSH goal；本 Run 以 Anchor 为目标权威。</p>}
      {activation !== undefined && (
        <p className="sam-note">Goal activation：{activation}{activation === 'disarmed' ? '（不会自动续跑）' : ''}</p>
      )}
      {run?.definitionOfDone && <p className="sam-dod"><strong>完成定义：</strong>{run.definitionOfDone}</p>}
      {anchor !== null && (
        <details className="sam-details">
          <summary>最新指令与约束</summary>
          <p>{anchor.latestInstruction}</p>
          {anchor.constraints.length > 0 && <ul className="sam-list">{anchor.constraints.map(item => <li key={item}>{item}</li>)}</ul>}
        </details>
      )}
    </section>
  )
}

function TeamCard({ mode, nativeFailure, nativeTaskCount, host }: {
  mode: ReturnType<typeof resolveTeamMode>
  nativeFailure: unknown
  nativeTaskCount: number | undefined
  host: SuperAgentProjection | null
}): ReactNode {
  return (
    <section className="sam-section" aria-labelledby="sam-team">
      <SectionTitle id="sam-team" title="原生 Team" />
      {mode === 'disabled' && <p className="sam-note" data-team="disabled">Team 未开启：任务板能力降级；仍只读显示原生子 Agent 目录。</p>}
      {mode === 'unknown' && <p className="sam-alert" data-team="unknown">? Team 状态 unknown（宿主与原生投影缺失或不一致）。</p>}
      {mode === 'enabled' && <p className="sam-note" data-team="enabled">Team 已开启 · 原生任务 {nativeTaskCount ?? '未知'} 项</p>}
      {typeof nativeFailure === 'string' && <p className="sam-alert" role="alert">原生 Team 投影错误：{nativeFailure}</p>}
      {host?.agentTeam.failure !== undefined && host.agentTeam.failure !== nativeFailure && (
        <p className="sam-alert" role="alert">Host Team 读取错误：{host.agentTeam.failure}</p>
      )}
    </section>
  )
}

function ObligationList({ projection }: { projection: SuperAgentProjection }): ReactNode {
  const open = projection.openObligations.filter(item => item.kind !== 'prohibition')
  const prohibitions = projection.obligations.filter(item => item.kind === 'prohibition' && (item.status === 'open' || item.status === 'violated'))
  if (open.length === 0 && prohibitions.length === 0) return <p className="sam-empty">暂无开放义务或生效中的禁止项。</p>
  return (
    <div className="sam-obligations">
      {open.length > 0 && <ul className="sam-list">{open.map(item => (
        <li key={item.id} data-kind={item.kind}>
          <span className="sam-item-id">{item.id}</span> · {item.text}
          {item.coverage !== undefined && <span> · 覆盖 {item.coverage}</span>}
        </li>
      ))}</ul>}
      {prohibitions.length > 0 && <ul className="sam-list sam-prohibitions">{prohibitions.map(item => (
        <li key={item.id} data-status={item.status}>
          <strong>{item.status === 'violated' ? '× 已违反' : '! 禁止'}</strong> · {item.text}
        </li>
      ))}</ul>}
    </div>
  )
}

function WorkItemRow({ item, projection }: { item: WorkItemDto; projection: SuperAgentProjection }): ReactNode {
  const meta = workStatusMeta(item.status)
  const mandate = projection.mandates.find(entry => entry.id === item.currentMandateId)
    ?? projection.mandates.filter(entry => entry.workItemId === item.id && entry.attempt === item.attempt).at(-1)
  const gate = projection.gates.filter(entry => entry.workItemId === item.id && entry.attempt === item.attempt).at(-1)
  const decisions = projection.decisions.filter(entry => entry.workItemId === item.id && entry.attempt === item.attempt && !entry.invalidated)
  const decision = decisions.at(-1)
  return (
    <li className="sam-work" data-status={item.status}>
      <div className="sam-work-heading">
        <strong>{item.title}</strong>
        <Badge tone={meta.tone} icon={meta.icon} label={meta.label} />
      </div>
      <dl className="sam-facts sam-work-facts">
        <div><dt>attempt</dt><dd>{item.attempt}</dd></div>
        <div><dt>Worker</dt><dd>{mandate?.workerId ?? '未绑定'}</dd></div>
        <div><dt>Reviewer</dt><dd>{mandate?.reviewerId ?? '未绑定'}</dd></div>
        <div><dt>原生任务</dt><dd>{item.nativeTaskId ?? mandate?.nativeTaskId ?? '未关联'}</dd></div>
      </dl>
      {item.dependencies.length > 0 && <p className="sam-note">依赖：{item.dependencies.join('、')}</p>}
      {item.acceptance.length > 0 && (
        <details className="sam-details"><summary>验收标准</summary><ul className="sam-list">{item.acceptance.map(entry => <li key={entry}>{entry}</li>)}</ul></details>
      )}
      <div className="sam-gate">
        {gate === undefined
          ? <span className="sam-note">门禁结果未提供</span>
          : <Badge {...evidenceStatusMeta(gate.result)} />}
        {decision !== undefined && <span>Reviewer：{decision.reviewerId} · {decision.result}</span>}
      </div>
      {gate !== undefined && gate.missingEvidence.length > 0 && <p className="sam-note">缺证据：{gate.missingEvidence.join('、')}</p>}
      {gate !== undefined && gate.reasons.length > 0 && <p className="sam-note">门禁原因：{gate.reasons.join('；')}</p>}
    </li>
  )
}

function MemberList({ members }: { members: MemberView[] }): ReactNode {
  if (members.length === 0) return <p className="sam-empty">原生子 Agent 目录为空。</p>
  return <ul className="sam-members">{members.map(member => (
    <li key={member.id} data-activity={member.activity ?? 'unknown'}>
      <strong>{member.name}</strong>
      <span>{memberActivityLabel(member)}</span>
      {member.mode !== undefined && <small>{member.mode}</small>}
      {member.modelRoute !== undefined && <small>当前 model.current()：{member.modelRoute === null ? '具体路由未知' : formatModelRoute(member.modelRoute)}</small>}
    </li>
  ))}</ul>
}

function EvidenceList({ projection }: { projection: SuperAgentProjection }): ReactNode {
  const visible = projection.evidence.slice(-50).reverse()
  return (
    <>
      {projection.evidence.length > visible.length && <p className="sam-note">仅显示最近 {visible.length} 条，共 {projection.evidence.length} 条。</p>}
      <ul className="sam-evidence">{visible.map(item => (
        <EvidenceRow key={item.id} item={item} />
      ))}</ul>
    </>
  )
}

function EvidenceRow({ item }: { item: SuperAgentProjection['evidence'][number] }): ReactNode {
  const meta = evidenceStatusMeta(item.result)
  return (
    <li data-result={item.result}>
      <div className="sam-evidence-heading">
        <Badge tone={meta.tone} icon={meta.icon} label={meta.label} />
        <strong>{item.kind}</strong>
        <span>attempt {item.attempt}</span>
      </div>
      <p>{item.summary || '未提供摘要'}</p>
      <small>{item.sourceRole} / {item.sourceActor} · {formatTime(item.createdAt)}</small>
      <details className="sam-details">
        <summary>回执</summary>
        <pre>{json(item.receipt)}</pre>
      </details>
    </li>
  )
}

function AuditTimeline({ projection }: { projection: SuperAgentProjection }): ReactNode {
  const visible = projection.audit.slice(-80).reverse()
  return (
    <>
      {projection.audit.length > visible.length && <p className="sam-note">仅显示最近 {visible.length} 条，共 {projection.audit.length} 条。</p>}
      <ol className="sam-audit">{visible.map(event => (
        <li key={event.id}>
          <time>{formatTime(event.timestamp)}</time>
          <div><strong>{event.type}</strong><span> · r{event.revision} / g{event.generation} · {event.actor}</span></div>
          {Object.keys(event.payload).length > 0 && (
            <details className="sam-details"><summary>事件内容</summary><pre>{json(event.payload)}</pre></details>
          )}
        </li>
      ))}</ol>
    </>
  )
}

function SectionTitle({ id, title }: { id: string; title: string }): ReactNode {
  return <h3 id={id}>{title}</h3>
}

function Badge({ tone, icon, label }: { tone: string; icon: string; label: string }): ReactNode {
  return <span className="sam-badge" data-tone={tone}><span aria-hidden="true">{icon}</span>{label}</span>
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? 'undefined'
  } catch {
    return '回执不可序列化'
  }
}
