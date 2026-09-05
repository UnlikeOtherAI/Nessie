// The gateway had no signal handler at all: SIGTERM killed the process outright,
// so its APNs HTTP/2 session was severed without a GOAWAY and every dead-token
// verdict still in flight was lost — those tokens then kept being pushed to.
// `sender.close()` runs from the app's `onClose`, which only a real
// `app.close()` reaches.

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildGatewayApp } from '../src/app.js'
import { drainGatewayServer, resolveShutdownTimeoutMs } from '../src/index.js'
import type { GatewayConfig, GatewaySender } from '../src/types.js'
import type { PushResult } from '@nessie/push'

const config: GatewayConfig = {
  apiKey: 'secret',
  host: '127.0.0.1',
  port: 0,
}

const sent = (): PushResult => ({ ok: true, status: 200, deadToken: false })

const closableSender = () => {
  let closed = 0
  const sender: GatewaySender = {
    sendApns: async () => sent(),
    sendFcm: async () => sent(),
    close: async () => {
      closed += 1
    },
  }
  return { sender, closedCount: () => closed }
}

test('drain closes the app, which is what tears the APNs session down, and exits 0', async () => {
  const { sender, closedCount } = closableSender()
  const app = buildGatewayApp({ config, sender, logger: false })
  await app.listen({ host: '127.0.0.1', port: 0 })

  const exits: number[] = []
  await drainGatewayServer({
    app,
    timeoutMs: 5_000,
    signal: 'SIGTERM',
    exit: ((code: number) => {
      exits.push(code)
    }) as unknown as (code: number) => never,
  })

  assert.equal(closedCount(), 1, 'the APNs session must be closed, not severed')
  assert.deepEqual(exits, [0])
})

test('a drain that outlives its deadline exits 1 instead of waiting for SIGKILL', async () => {
  const exits: number[] = []
  // A close that never settles is the wedged-shutdown case the timer exists for.
  const wedged = { close: () => new Promise<void>(() => {}) }

  await Promise.race([
    drainGatewayServer({
      app: wedged,
      timeoutMs: 50,
      exit: ((code: number) => {
        exits.push(code)
      }) as unknown as (code: number) => never,
    }),
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ])

  assert.deepEqual(exits, [1], 'the hard timer must fire when the drain hangs')
})

test('NESSIE_SHUTDOWN_TIMEOUT_MS overrides the 25s default, and junk falls back', () => {
  assert.equal(resolveShutdownTimeoutMs({}), 25_000)
  assert.equal(resolveShutdownTimeoutMs({ NESSIE_SHUTDOWN_TIMEOUT_MS: '  ' }), 25_000)
  assert.equal(resolveShutdownTimeoutMs({ NESSIE_SHUTDOWN_TIMEOUT_MS: '0' }), 25_000)
  assert.equal(resolveShutdownTimeoutMs({ NESSIE_SHUTDOWN_TIMEOUT_MS: 'soon' }), 25_000)
  assert.equal(resolveShutdownTimeoutMs({ NESSIE_SHUTDOWN_TIMEOUT_MS: '9000' }), 9_000)
})
