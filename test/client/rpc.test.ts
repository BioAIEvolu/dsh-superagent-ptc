import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createProjectionBridge,
  decodeProjectionEnvelope,
  requireRpcCarrier,
  unavailableProjectionBridge,
} from '../../src/client/rpc.ts'
import { emptyProjection } from './fixtures.ts'

test('RPC bridge calls the shared /api target with exact sessionId and preserves this', async () => {
  const calls: unknown[][] = []
  const service = {
    rpc: {
      marker: 42,
      async call(this: { marker: number }, ...args: unknown[]) {
        assert.equal(this.marker, 42)
        calls.push(args)
        return { ok: true, value: emptyProjection() }
      },
    },
  }
  const bridge = createProjectionBridge(service)
  const result = await bridge.read('session-1')
  assert.equal(result.status, 'ready')
  assert.deepEqual(calls, [['/api', 'dsh-super-agent-mode/projection', { sessionId: 'session-1' }, undefined]])
})

test('host error envelopes fail closed with their real code', async () => {
  const bridge = createProjectionBridge({ rpc: { async call() {
    return { ok: false, error: { code: 'SESSION_NOT_FOUND', message: '会话不存在' } }
  } } })
  const result = await bridge.read('session-1')
  assert.deepEqual(result, { status: 'unavailable', code: 'SESSION_NOT_FOUND', message: '会话不存在' })
  assert.throws(() => decodeProjectionEnvelope({ ok: false }, 'session-1'), /宿主投影不可用/)
})

test('network failures and malformed envelopes never produce a projection', async () => {
  const network = createProjectionBridge({ rpc: { async call() { throw new Error('socket closed') } } })
  assert.deepEqual(await network.read('session-1'), { status: 'unavailable', code: 'rpc_unavailable', message: 'socket closed' })
  for (const envelope of [null, {}, { ok: 'yes' }, { ok: true, value: null }, { ok: true, value: emptyProjection('other') }]) {
    const bridge = createProjectionBridge({ rpc: { async call() { return envelope } } })
    const result = await bridge.read('session-1')
    assert.equal(result.status, 'unavailable')
    assert.equal('projection' in result, false)
  }
})

test('missing connection faces are explicit unavailable states', async () => {
  for (const service of [undefined, null, {}, { rpc: {} }]) assert.throws(() => requireRpcCarrier(service))
  const result = await unavailableProjectionBridge('缺少 connection').read('session-1')
  assert.deepEqual(result, { status: 'unavailable', code: 'connection_unavailable', message: '缺少 connection' })
})
