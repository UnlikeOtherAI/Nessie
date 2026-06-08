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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startGatewayServer()
}
