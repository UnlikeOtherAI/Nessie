import { pathToFileURL } from 'node:url'
import { buildGatewayApp } from './app.js'
import { loadGatewayConfig } from './config.js'
import { createGatewaySender } from './sender.js'

export { buildGatewayApp } from './app.js'
export { loadGatewayConfig } from './config.js'
export { createGatewaySender } from './sender.js'
export type {
  GatewayConfig,
  GatewayPushPayload,
  GatewayPushRequest,
  GatewayPushResponse,
  GatewayPushTarget,
  GatewaySender,
  GatewayTargetResult,
} from './types.js'

export const startGatewayServer = async () => {
  const config = loadGatewayConfig()
  const sender = createGatewaySender(config)
  const app = buildGatewayApp({ config, sender })

  await app.listen({
    host: config.host,
    port: config.port,
  })

  return app
}

// Hard ceiling on the drain. The gateway does not load `@nessie/config` (it has
// its own tiny env loader and no dependency on the package), so it reads the
// same `NESSIE_SHUTDOWN_TIMEOUT_MS` variable directly, with the same 25 s
// default the API's `shutdownTimeoutMs` carries.
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000

export const resolveShutdownTimeoutMs = (env: NodeJS.ProcessEnv): number => {
  const raw = env.NESSIE_SHUTDOWN_TIMEOUT_MS?.trim()
  if (!raw) return DEFAULT_SHUTDOWN_TIMEOUT_MS

  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SHUTDOWN_TIMEOUT_MS
}

/**
 * Drain the gateway and exit.
 *
 * `app.close()` stops accepting and runs the registered `onClose`, which is
 * where `sender.close()` tears the APNs HTTP/2 session down with a GOAWAY.
 * Without this the session was severed mid-flight on every deploy and the
 * dead-token verdicts still in it were lost, so those tokens kept being pushed
 * to. The gateway holds no long-lived client connections of its own, so there
 * is nothing to notify first — unlike the API, it goes straight to close.
 */
export const drainGatewayServer = async (input: {
  // Only `close()` is needed, so the deadline branch is reachable in a test
  // without wedging a real listening server.
  app: { close: () => Promise<unknown> }
  timeoutMs: number
  exit?: (code: number) => never
  signal?: string
}): Promise<void> => {
  const exit = input.exit ?? ((code: number): never => process.exit(code))
  const deadline = setTimeout(() => {
    console.error(`[gateway] shutdown exceeded ${input.timeoutMs}ms; exiting`)
    exit(1)
  }, input.timeoutMs)

  try {
    console.log(`[gateway] ${input.signal ?? 'shutdown'} received; draining`)
    await input.app.close()
    clearTimeout(deadline)
    exit(0)
  } catch (error) {
    clearTimeout(deadline)
    console.error('[gateway] drain failed', error)
    exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await startGatewayServer()
  const timeoutMs = resolveShutdownTimeoutMs(process.env)
  // `once`, not `on`: a second signal falls through to Node's default and kills
  // the process rather than starting a second drain over the first.
  process.once('SIGTERM', () => {
    void drainGatewayServer({ app, timeoutMs, signal: 'SIGTERM' })
  })
  process.once('SIGINT', () => {
    void drainGatewayServer({ app, timeoutMs, signal: 'SIGINT' })
  })
}
