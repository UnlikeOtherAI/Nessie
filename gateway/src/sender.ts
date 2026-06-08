import { PushSender } from '@nessie/push'
import type { GatewayConfig, GatewaySender } from './types.js'

export const createGatewaySender = (config: GatewayConfig): GatewaySender =>
  new PushSender({
    apns: config.apns,
    fcm: config.fcm,
  })
