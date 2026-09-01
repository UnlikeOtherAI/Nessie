import type { FastifyCorsOptions } from '@fastify/cors'

import type { AppConfig } from './server-context.js'

const localCorsOrigins = new Set([
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5455',
  'http://localhost:3000',
  'http://localhost:5455',
])

const desktopAppCorsOrigins = new Set([
  'tauri://localhost',
  'http://tauri.localhost',
])

type OriginPolicy = {
  origin: string | undefined
  allowedOrigins: Set<string>
  mode: AppConfig['mode']
}

export const parseOriginList = (
  ...values: Array<string | undefined>
): Set<string> => {
  const origins = new Set<string>()
  for (const value of values) {
    for (const origin of value?.split(',') ?? []) {
      const trimmed = origin.trim().replace(/\/$/, '')
      if (trimmed) origins.add(trimmed)
    }
  }
  return origins
}

export const isOriginAllowed = (input: OriginPolicy): boolean => {
  if (!input.origin) return true
  const normalizedOrigin = input.origin.replace(/\/$/, '')
  return (
    input.allowedOrigins.has(normalizedOrigin)
    || desktopAppCorsOrigins.has(normalizedOrigin)
    || (input.mode === 'local' && localCorsOrigins.has(normalizedOrigin))
  )
}

export const createCorsOriginChecker = (input: {
  allowedOrigins: Set<string>
  mode: AppConfig['mode']
}): NonNullable<FastifyCorsOptions['origin']> =>
  (origin, callback) => {
    callback(null, isOriginAllowed({
      origin: origin ?? undefined,
      allowedOrigins: input.allowedOrigins,
      mode: input.mode,
    }))
  }

export const buildStreamCorsHeaders = (
  input: OriginPolicy,
): Record<string, string> => {
  if (!input.origin || !isOriginAllowed(input)) return {}
  return {
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Origin': input.origin,
    Vary: 'Origin',
  }
}
