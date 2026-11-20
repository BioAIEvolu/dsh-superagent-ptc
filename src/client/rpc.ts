import { rpcTarget } from '../shared/wire.ts'
import {
  parseHostProjection,
  ProjectionDataError,
  type SuperAgentProjection,
} from './projection.ts'

export const PROJECTION_TARGET = rpcTarget('projection')

export interface RpcEnvelope {
  ok: boolean
  value?: unknown
  error?: { code?: unknown; message?: unknown }
}

export interface RpcCarrier {
  rpc: {
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown>
  }
}

export type ProjectionResult =
  | { status: 'ready'; projection: SuperAgentProjection }
  | { status: 'unavailable'; code: string; message: string }

export interface ProjectionBridge {
  read(sessionId: string, signal?: AbortSignal): Promise<ProjectionResult>
}

export class ProjectionRpcError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ProjectionRpcError'
    this.code = code
  }
}

/** Narrow the DSH connection service without importing the stale hoisted slots/client types. */
export function requireRpcCarrier(service: unknown): RpcCarrier {
  if (typeof service !== 'object' || service === null) {
    throw new ProjectionRpcError('connection_unavailable', 'connection 服务不可用')
  }
  const rpc = (service as { rpc?: unknown }).rpc
  if (typeof rpc !== 'object' || rpc === null) {
    throw new ProjectionRpcError('connection_unavailable', 'connection.rpc 不可用')
  }
  const call = (rpc as { call?: unknown }).call
  if (typeof call !== 'function') {
    throw new ProjectionRpcError('connection_unavailable', 'connection.rpc.call 不可用')
  }
  const invoke = call as (this: unknown, ...args: unknown[]) => Promise<unknown>
  return {
    rpc: {
      call: (channel, endpoint, payload, signal) => invoke.call(rpc, channel, endpoint, payload, signal),
    },
  }
}

/** Decode the ConnectionRpcResult envelope and reject malformed/cross-session data. */
export function decodeProjectionEnvelope(value: unknown, sessionId: string): SuperAgentProjection {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProjectionRpcError('malformed_envelope', '宿主 RPC 信封不是对象')
  }
  const envelope = value as RpcEnvelope
  if (envelope.ok === false) {
    const code = typeof envelope.error?.code === 'string' ? envelope.error.code : 'host_unavailable'
    const message = typeof envelope.error?.message === 'string' ? envelope.error.message : '宿主投影不可用'
    throw new ProjectionRpcError(code, message)
  }
  if (envelope.ok !== true) throw new ProjectionRpcError('malformed_envelope', '宿主 RPC 信封缺少 ok')
  return parseHostProjection(envelope.value, sessionId)
}

function unavailable(error: unknown): ProjectionResult {
  if (error instanceof ProjectionRpcError || error instanceof ProjectionDataError) {
    return { status: 'unavailable', code: error.code, message: error.message }
  }
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '网络或宿主未知错误'
  return { status: 'unavailable', code: 'rpc_unavailable', message }
}

export function createProjectionBridge(service: unknown): ProjectionBridge {
  const carrier = requireRpcCarrier(service)
  return {
    async read(sessionId, signal) {
      try {
        const result = await carrier.rpc.call(PROJECTION_TARGET.channel, PROJECTION_TARGET.endpoint, { sessionId }, signal)
        return { status: 'ready', projection: decodeProjectionEnvelope(result, sessionId) }
      } catch (error) {
        return unavailable(error)
      }
    },
  }
}

export function unavailableProjectionBridge(message: string): ProjectionBridge {
  return {
    read: async () => ({ status: 'unavailable', code: 'connection_unavailable', message }),
  }
}
