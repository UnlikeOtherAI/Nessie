import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseServiceAccount } from '@nessie/push'
import type { ApnsCredentials, FcmCredentials } from '@nessie/push'
import type { GatewayConfig } from './types.js'

const optional = (env: NodeJS.ProcessEnv, key: string): string | undefined => {
  const value = env[key]?.trim()
  return value ? value : undefined
}

const required = (env: NodeJS.ProcessEnv, key: string): string => {
  const value = optional(env, key)
  if (!value) throw new Error(`${key} is required`)
  return value
}

const loadP8 = (value: string, baseDir: string): string => {
  const normalized = value.replaceAll('\\n', '\n')
  if (normalized.includes('BEGIN PRIVATE KEY')) return normalized

  const path = resolve(baseDir, value)
  if (!existsSync(path)) {
    throw new Error('PUSH_APNS_P8 must be private key contents or a readable file path')
  }
  return readFileSync(path, 'utf8')
}

const loadApnsCredentials = (
  env: NodeJS.ProcessEnv,
  baseDir: string,
): ApnsCredentials | undefined => {
  const keys = [
    'PUSH_APNS_P8',
    'PUSH_APNS_KEY_ID',
    'PUSH_APNS_TEAM_ID',
    'PUSH_APNS_TOPIC',
    'PUSH_APNS_ENV',
  ]
  const present = keys.filter((key) => optional(env, key) !== undefined)
  if (present.length === 0) return undefined

  const missing = keys.filter((key) => optional(env, key) === undefined)
  if (missing.length > 0) {
    throw new Error(`APNs configuration is incomplete; missing ${missing.join(', ')}`)
  }

  const environment = parseApnsEnvironment(required(env, 'PUSH_APNS_ENV'))
  return {
    p8: loadP8(required(env, 'PUSH_APNS_P8'), baseDir),
    keyId: required(env, 'PUSH_APNS_KEY_ID'),
    teamId: required(env, 'PUSH_APNS_TEAM_ID'),
    topic: required(env, 'PUSH_APNS_TOPIC'),
    environment,
  }
}

const parseApnsEnvironment = (environment: string): ApnsCredentials['environment'] => {
  if (environment === 'sandbox' || environment === 'production') return environment
  throw new Error('PUSH_APNS_ENV must be "sandbox" or "production"')
}

const assertServiceAccountType = (json: string): void => {
  const parsed = JSON.parse(json) as Record<string, unknown>
  if (parsed.type !== 'service_account') {
    throw new Error('PUSH_FCM_SERVICE_ACCOUNT must be a Firebase service-account JSON object')
  }
}

const loadFcmCredentials = (env: NodeJS.ProcessEnv): FcmCredentials | undefined => {
  const serviceAccountJson = optional(env, 'PUSH_FCM_SERVICE_ACCOUNT')
  if (!serviceAccountJson) return undefined

  assertServiceAccountType(serviceAccountJson)
  parseServiceAccount(serviceAccountJson)
  return { serviceAccountJson }
}

const loadPort = (env: NodeJS.ProcessEnv): number => {
  const value = optional(env, 'GATEWAY_PORT') ?? optional(env, 'PORT') ?? '5556'
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('GATEWAY_PORT must be an integer between 1 and 65535')
  }
  return port
}

export const loadGatewayConfig = (
  env: NodeJS.ProcessEnv = process.env,
  baseDir: string = process.cwd(),
): GatewayConfig => ({
  apiKey: required(env, 'GATEWAY_API_KEY'),
  host: optional(env, 'GATEWAY_HOST') ?? '0.0.0.0',
  port: loadPort(env),
  apns: loadApnsCredentials(env, baseDir),
  fcm: loadFcmCredentials(env),
})
