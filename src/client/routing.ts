import type {
  ModelFailureKind,
  ModelPolicyMode,
  ModelRouteDto,
  NativeMemberDto,
  RouteFailureDto,
  RouteSwitchDto,
} from './projection.ts'

export interface FailureKindMeta {
  label: string
  handling: string
  tone: 'fail' | 'unknown' | 'active'
}

export function failureKindMeta(kind: ModelFailureKind): FailureKindMeta {
  const retryable = new Set<ModelFailureKind>(['transient', 'timeout', 'rate_limit'])
  const switchable = new Set<ModelFailureKind>(['quota', 'account_quota', 'provider_unavailable', 'route_incompatible'])
  const labels: Record<ModelFailureKind, string> = {
    transient: '临时网络故障',
    timeout: '请求超时',
    rate_limit: '速率限制',
    quota: '额度限制',
    account_quota: '账户额度限制',
    provider_unavailable: 'Provider 不可用',
    route_incompatible: '路由不兼容',
    authentication: '认证失败',
    permission: '权限拒绝',
    tool_input: '工具参数错误',
    business_acceptance: '业务验收失败',
    snapshot_proof: '快照证明失败',
    write_scope: '写域错误',
    identity: '身份错误',
    unknown: '未知故障',
  }
  if (retryable.has(kind)) return { label: labels[kind], handling: '可按预算重试', tone: 'active' }
  if (switchable.has(kind)) return { label: labels[kind], handling: '可按授权切换', tone: 'unknown' }
  if (kind === 'unknown') return { label: labels[kind], handling: '失败封闭，不盲目切换', tone: 'unknown' }
  return { label: labels[kind], handling: '不自动重试或切换', tone: 'fail' }
}

export function policyModeLabel(mode: ModelPolicyMode): string {
  return { locked: 'locked · 锁定', balanced: 'balanced · 均衡', economy: 'economy · 经济', performance: 'performance · 性能' }[mode]
}

/** Null is the host's explicit inheritance marker; undefined is an absent historical record. */
export function mandateRouteLabel(route: ModelRouteDto | null | undefined): string {
  if (route === null) return '继承（Mandate 显式记录）'
  if (route === undefined) return '未记录（历史 Mandate）'
  return formatModelRoute(route)
}

export function policyRouteLabel(route: ModelRouteDto | undefined): string {
  return route === undefined ? '未指定（由 Mandate 决定）' : formatModelRoute(route)
}

export function formatModelRoute(route: ModelRouteDto): string {
  const base = route.provider + ' / ' + route.model
  return route.reasoningEffort === undefined ? base : base + ' · reasoning ' + route.reasoningEffort
}

export function routeSwitchStatusLabel(status: RouteSwitchDto['status']): string {
  return { requested: '已请求', rejected: '已拒绝', exhausted: '预算耗尽' }[status]
}

export function routeFailureActionLabel(action: RouteFailureDto['action']): string {
  return { rejected: '已拒绝', retry_recorded: '已记录同路由重试', switch_required: '需要切换或用户处理' }[action]
}

export interface MandateRouteReadback {
  status: 'matched' | 'inherited' | 'unknown'
  label: string
  actual?: ModelRouteDto | null
}

/** Compare only real model.current() data; any absent/inconsistent evidence stays unknown. */
export function readMandateRoute(
  expected: ModelRouteDto | null | undefined,
  nativeAgentId: string | undefined,
  members: readonly NativeMemberDto[],
): MandateRouteReadback {
  if (nativeAgentId === undefined) return { status: 'unknown', label: '未关联原生 Agent，无法回读' }
  const member = members.find(entry => entry.id === nativeAgentId)
  if (member?.modelRoute === undefined) return { status: 'unknown', label: '宿主投影未提供原生 model.current()；路由按 Mandate 记录继承，不追踪 provider/model' }
  const actual = member.modelRoute
  if (expected === null) {
    return { status: 'inherited', actual, label: actual === null ? '继承 · 当前具体路由未知' : '继承 · 实际 ' + formatModelRoute(actual) }
  }
  if (expected === undefined) {
    return { status: 'unknown', actual, label: actual === null ? '历史预期未记录 · 当前路由未知' : '历史预期未记录 · 实际 ' + formatModelRoute(actual) }
  }
  if (actual === null) return { status: 'unknown', actual, label: '预期 ' + formatModelRoute(expected) + ' · 当前路由未知' }
  const matches = expected.provider === actual.provider && expected.model === actual.model
    && (expected.reasoningEffort === undefined || expected.reasoningEffort === actual.reasoningEffort)
  return {
    status: matches ? 'matched' : 'unknown',
    actual,
    label: matches ? '回读一致 · ' + formatModelRoute(actual) : '路由不一致 · unknown · 预期 ' + formatModelRoute(expected) + ' / 实际 ' + formatModelRoute(actual),
  }
}

/** Used counts come from each actual RouteFailure; never infer usage from attempt numbers. */
export function remainingRouteBudget(limit: number, used: number): number {
  return Math.max(0, limit - used)
}
