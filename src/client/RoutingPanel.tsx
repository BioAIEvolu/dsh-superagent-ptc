import type { ReactNode } from 'react'
import type {
  MandateDto,
  ModelPolicyDto,
  RouteFailureDto,
  RouteSwitchDto,
  SuperAgentProjection,
} from './projection.ts'
import {
  failureKindMeta,
  formatModelRoute,
  mandateRouteLabel,
  policyModeLabel,
  policyRouteLabel,
  readMandateRoute,
  remainingRouteBudget,
  routeFailureActionLabel,
  routeSwitchStatusLabel,
} from './routing.ts'

export function RoutingSection({ projection }: { projection: SuperAgentProjection }): ReactNode {
  const policy = projection.run?.modelPolicy
  const mandates = currentMandates(projection)
  const failures = projection.routeFailures ?? []
  // Historical switches remain auditable even after a new current Mandate/attempt.
  const switches = projection.mandates.flatMap(mandate => mandate.routeSwitches ?? [])
  return (
    <section className="sam-section sam-routing" aria-labelledby="sam-routing" data-routing>
      <h3 id="sam-routing">模型策略与路由审计</h3>
      {policy === undefined ? (
        <p className="sam-empty" data-routing-empty>当前 Run 未配置 ModelPolicy；默认路由与预算未知，不填造 provider/model。如需路由策略，由 Lead 通过 super_route set 配置。</p>
      ) : (
        <PolicyCard policy={policy} />
      )}

      <div className="sam-route-mandates">
        <h4>Worker / Reviewer · Mandate 固化记录</h4>
        {mandates.length === 0 ? (
          <p className="sam-empty">暂无 Mandate 路由记录。</p>
        ) : mandates.map(mandate => (
          <MandateRoute key={mandate.id} mandate={mandate} projection={projection} />
        ))}
      </div>

      <div className="sam-route-failures">
        <h4>故障分类与剩余预算</h4>
        {failures.length === 0 ? (
          <p className="sam-empty">暂无 RouteFailure 记录；这不等同于证明路由成功。</p>
        ) : failures.slice(-20).reverse().map(failure => (
          <FailureRow key={failure.id} failure={failure} policy={policy} />
        ))}
      </div>

      {switches.length > 0 && (
        <details className="sam-details sam-route-switches">
          <summary>路由切换审计 · {switches.length} 条</summary>
          <ol>{switches.slice().reverse().map(entry => <SwitchRow key={entry.id} entry={entry} />)}</ol>
        </details>
      )}
      <p className="sam-note">仅展示 Host 实际投影；Reviewer 工具预设与业务证据门不因路由切换改变。</p>
    </section>
  )
}

function PolicyCard({ policy }: { policy: ModelPolicyDto }): ReactNode {
  return (
    <div className="sam-policy" data-policy-mode={policy.mode}>
      <dl className="sam-facts">
        <div><dt>ModelPolicy</dt><dd>{policyModeLabel(policy.mode)} · r{policy.revision}</dd></div>
        <div><dt>允许路线</dt><dd>{policy.allowedRoutes.length} 条</dd></div>
        <div><dt>Worker 默认</dt><dd>{policyRouteLabel(policy.workerRoute)}</dd></div>
        <div><dt>Reviewer 默认</dt><dd>{policyRouteLabel(policy.reviewerRoute)}</dd></div>
        <div><dt>同路由重试预算</dt><dd>{policy.maxSameRouteRetries}</dd></div>
        <div><dt>路由切换预算</dt><dd>{policy.maxRouteSwitches}</dd></div>
      </dl>
      <p className="sam-note">故障切换：{policy.allowFailureSwitch ? '已授权（仍受路线池与预算限制）' : '未授权'}{policy.cooldownMs === undefined ? '' : ' · 冷却提示 ' + policy.cooldownMs + ' ms'}</p>
      <details className="sam-details">
        <summary>查看授权路线池</summary>
        {policy.allowedRoutes.length === 0 ? <p className="sam-empty">允许路线为空，未配置可切换目标。</p> : (
          <ul className="sam-list">{policy.allowedRoutes.map((route, index) => (
            <li key={route.provider + '/' + route.model + '/' + (route.reasoningEffort ?? '') + '/' + index}>{formatModelRoute(route)}</li>
          ))}</ul>
        )}
      </details>
    </div>
  )
}

function currentMandates(projection: SuperAgentProjection): MandateDto[] {
  const ids = new Set<string>()
  const selected: MandateDto[] = []
  for (const item of projection.workItems) {
    const mandate = projection.mandates.find(entry => entry.id === item.currentMandateId)
      ?? projection.mandates.filter(entry => entry.workItemId === item.id && entry.attempt === item.attempt).at(-1)
    if (mandate !== undefined && !ids.has(mandate.id)) {
      ids.add(mandate.id)
      selected.push(mandate)
    }
  }
  return selected
}

function MandateRoute({ mandate, projection }: { mandate: MandateDto; projection: SuperAgentProjection }): ReactNode {
  const item = projection.workItems.find(entry => entry.id === mandate.workItemId)
  const workerReadback = readMandateRoute(mandate.workerRoute, mandate.workerAgentId, projection.subagentCatalog)
  const reviewerReadback = readMandateRoute(mandate.reviewerRoute, mandate.reviewerAgentId, projection.subagentCatalog)
  return (
    <article className="sam-route-record" data-mandate={mandate.id}>
      <strong>{item?.title ?? mandate.workItemId}</strong>
      <dl className="sam-facts">
        <div><dt>Worker 路由</dt><dd>{mandateRouteLabel(mandate.workerRoute)}</dd></div>
        <div><dt>Reviewer 路由</dt><dd>{mandateRouteLabel(mandate.reviewerRoute)}</dd></div>
        <div><dt>策略 revision</dt><dd>{mandate.policyRevision ?? '未记录'}</dd></div>
        <div><dt>attempt / generation</dt><dd>{mandate.attempt} / {mandate.generation}</dd></div>
      </dl>
      <p className="sam-route-readback" data-readback={workerReadback.status}>Worker 回读：{workerReadback.label}</p>
      <p className="sam-route-readback" data-readback={reviewerReadback.status}>Reviewer 回读：{reviewerReadback.label}</p>
      <p className="sam-route-reason"><span>选择理由：</span>{mandate.routeReason ?? '未记录选择理由'}</p>
    </article>
  )
}

function FailureRow({ failure, policy }: { failure: RouteFailureDto; policy: ModelPolicyDto | undefined }): ReactNode {
  const meta = failureKindMeta(failure.failureKind)
  const retryRemaining = policy === undefined ? undefined : remainingRouteBudget(policy.maxSameRouteRetries, failure.sameRouteRetries)
  const switchRemaining = policy === undefined ? undefined : remainingRouteBudget(policy.maxRouteSwitches, failure.routeSwitches)
  return (
    <article className="sam-route-failure" data-failure-kind={failure.failureKind}>
      <div className="sam-route-failure-heading">
        <span className="sam-badge" data-tone={meta.tone}><span aria-hidden="true">{meta.tone === 'fail' ? '×' : meta.tone === 'active' ? '↻' : '?'}</span>{meta.label}</span>
        <code>{failure.failureCode}</code>
      </div>
      <p>{meta.handling} · {routeFailureActionLabel(failure.action)}</p>
      <p className="sam-note">Mandate {failure.mandateId} · 路由 {failure.route === null ? '继承（具体值未知）' : formatModelRoute(failure.route)} · {formatTime(failure.createdAt)}</p>
      <dl className="sam-facts">
        <div><dt>同路由重试</dt><dd>已用 {failure.sameRouteRetries}{policy === undefined ? ' · 剩余未知' : ' / 剩余 ' + retryRemaining + ' / 上限 ' + policy.maxSameRouteRetries}</dd></div>
        <div><dt>路线切换</dt><dd>已用 {failure.routeSwitches}{policy === undefined ? ' · 剩余未知' : ' / 剩余 ' + switchRemaining + ' / 上限 ' + policy.maxRouteSwitches}</dd></div>
      </dl>
    </article>
  )
}

function SwitchRow({ entry }: { entry: RouteSwitchDto }): ReactNode {
  return (
    <li data-switch-status={entry.status}>
      <strong>{routeSwitchStatusLabel(entry.status)}</strong> · {entry.failureCode}
      <p>{entry.from === null ? '继承' : formatModelRoute(entry.from)} → {entry.to === null ? '继承' : formatModelRoute(entry.to)}</p>
      <p>{entry.reason}</p>
      <small>{entry.actor} · attempt {entry.attempt} / generation {entry.generation} · {formatTime(entry.createdAt)}</small>
    </li>
  )
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}
