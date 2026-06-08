import type {
  ApnsCredentials,
  FcmCredentials,
  PushPayload,
  PushResult,
  PushTarget,
} from '@nessie/push'

export type GatewayPlatform = 'ios' | 'android'

export interface GatewayPushTarget {
  token: string
  platform: GatewayPlatform
}

export interface GatewayPushPayload {
  title: string
  body: string
  badge?: number
  data?: Record<string, string>
  collapseId?: string
}

export interface GatewayPushRequest {
  targets: GatewayPushTarget[]
  payload: GatewayPushPayload
}

export interface GatewayTargetResult {
  token: string
  ok: boolean
  deadToken: boolean
  error?: string
}

export interface GatewayPushResponse {
  results: GatewayTargetResult[]
}

export interface GatewayConfig {
  apiKey: string
  host: string
  port: number
  apns?: ApnsCredentials
  fcm?: FcmCredentials
}

export interface GatewaySender {
  sendApns(target: PushTarget, payload: PushPayload): Promise<PushResult>
  sendFcm(target: PushTarget, payload: PushPayload): Promise<PushResult>
  close?(): Promise<void>
}
