import Fastify from 'fastify'
import type {
  GatewayConfig,
  GatewayPushPayload,
  GatewayPushRequest,
  GatewayPushResponse,
  GatewayPushTarget,
  GatewaySender,
  GatewayTargetResult,
} from './types.js'

interface BuildGatewayAppOptions {
  config: GatewayConfig
  sender: GatewaySender
  logger?: boolean
}

interface ValidationResult {
  ok: boolean
  request?: GatewayPushRequest
  error?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parseTarget = (value: unknown, index: number): GatewayPushTarget | string => {
  if (!isRecord(value)) return `targets[${index}] must be an object`
  if (typeof value.token !== 'string' || value.token.length === 0) {
    return `targets[${index}].token must be a non-empty string`
  }
  if (value.platform !== 'ios' && value.platform !== 'android') {
    return `targets[${index}].platform must be "ios" or "android"`
  }
  return { token: value.token, platform: value.platform }
}

const parseData = (value: unknown): Record<string, string> | string | undefined => {
  if (value === undefined) return undefined
  if (!isRecord(value)) return 'payload.data must be an object'
  const data: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') return `payload.data.${key} must be a string`
    data[key] = entry
  }
  return data
}

const parsePayload = (value: unknown): GatewayPushPayload | string => {
  if (!isRecord(value)) return 'payload must be an object'
  if (typeof value.title !== 'string') return 'payload.title must be a string'
  if (typeof value.body !== 'string') return 'payload.body must be a string'
  const badge = value.badge
  if (
    badge !== undefined
    && (typeof badge !== 'number' || !Number.isInteger(badge) || badge < 0)
  ) {
    return 'payload.badge must be a non-negative integer'
  }
  const collapseId = value.collapseId
  if (collapseId !== undefined && typeof collapseId !== 'string') {
    return 'payload.collapseId must be a string'
  }
  const data = parseData(value.data)
  if (typeof data === 'string') return data

  return {
    title: value.title,
    body: value.body,
    ...(badge !== undefined ? { badge } : {}),
    ...(data !== undefined ? { data } : {}),
    ...(collapseId !== undefined ? { collapseId } : {}),
  }
}

const parseRequestBody = (body: unknown): ValidationResult => {
  if (!isRecord(body)) return { ok: false, error: 'body must be a JSON object' }
  if (!Array.isArray(body.targets)) {
    return { ok: false, error: 'targets must be an array' }
  }
  const targets: GatewayPushTarget[] = []
  for (const [index, target] of body.targets.entries()) {
    const parsed = parseTarget(target, index)
    if (typeof parsed === 'string') return { ok: false, error: parsed }
    targets.push(parsed)
  }
  const payload = parsePayload(body.payload)
  if (typeof payload === 'string') return { ok: false, error: payload }
  return { ok: true, request: { targets, payload } }
}

const unauthorized = (authorization: string | undefined, apiKey: string): boolean =>
  authorization !== `Bearer ${apiKey}`

const providerMissingResult = (token: string, provider: 'APNs' | 'FCM'): GatewayTargetResult => ({
  token,
  ok: false,
  deadToken: false,
  error: `${provider} is not configured`,
})

const sendTarget = async (
  target: GatewayPushTarget,
  payload: GatewayPushPayload,
  config: GatewayConfig,
  sender: GatewaySender,
): Promise<GatewayTargetResult> => {
  if (target.platform === 'ios') {
    if (!config.apns) return providerMissingResult(target.token, 'APNs')
    try {
      const result = await sender.sendApns({ token: target.token }, payload)
      return {
        token: target.token,
        ok: result.ok,
        deadToken: result.deadToken,
        ...(result.error !== undefined ? { error: result.error } : {}),
      }
    } catch (cause) {
      return {
        token: target.token,
        ok: false,
        deadToken: false,
        error: cause instanceof Error ? cause.message : String(cause),
      }
    }
  }

  if (!config.fcm) return providerMissingResult(target.token, 'FCM')
  try {
    const result = await sender.sendFcm({ token: target.token }, payload)
    return {
      token: target.token,
      ok: result.ok,
      deadToken: result.deadToken,
      ...(result.error !== undefined ? { error: result.error } : {}),
    }
  } catch (cause) {
    return {
      token: target.token,
      ok: false,
      deadToken: false,
      error: cause instanceof Error ? cause.message : String(cause),
    }
  }
}

export const buildGatewayApp = ({ config, sender, logger = true }: BuildGatewayAppOptions) => {
  const app = Fastify({ logger })

  app.get('/health', { config: { public: true } }, async () => ({ ok: true }))

  app.post('/v1/push', async (request, reply) => {
    const authorization = Array.isArray(request.headers.authorization)
      ? request.headers.authorization[0]
      : request.headers.authorization
    if (unauthorized(authorization, config.apiKey)) {
      return reply.status(401).send({ error: 'unauthorized' })
    }

    const parsed = parseRequestBody(request.body)
    if (!parsed.ok || !parsed.request) {
      return reply.status(400).send({
        error: 'invalid_request',
        message: parsed.error ?? 'invalid request body',
      })
    }
    const pushRequest = parsed.request

    const results = await Promise.all(
      pushRequest.targets.map((target) =>
        sendTarget(target, pushRequest.payload, config, sender),
      ),
    )
    const response: GatewayPushResponse = { results }
    return reply.send(response)
  })

  app.addHook('onClose', async () => {
    await sender.close?.()
  })

  return app
}
