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
  /**
   * Base domain under which every team hostname lives, e.g. `nessie.works`.
   *
   * Team hosts are `<team>.<org>.<base>` and are created by people, not by
   * deployment config, so they cannot be enumerated in an allow-list the way
   * `app.nessie.works` can. Absent means the deployment does not route teams by
   * hostname and the exact-match list is the whole policy.
   */
  teamHostBaseDomain?: string | undefined
}

/**
 * Whether an origin is a team host under the configured base domain.
 *
 * Deliberately strict about shape rather than merely checking the suffix:
 * `https://evil-nessie.works` ends with `nessie.works` as a *string* and must
 * not be admitted, so the check is on labels — https, exactly two labels in
 * front of the base, and each of them a legal DNS label.
 */
const isTeamHostOrigin = (origin: string, baseDomain: string | undefined): boolean => {
  if (!baseDomain) return false

  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.port) return false

  const base = baseDomain.trim().toLowerCase().replace(/^\.+|\.+$/g, '')
  const host = url.hostname.toLowerCase()
  if (!base || !host.endsWith(`.${base}`)) return false

  const prefix = host.slice(0, -(base.length + 1))
  const labels = prefix.split('.')
  if (labels.length !== 2) return false

  return labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
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
    || isTeamHostOrigin(normalizedOrigin, input.teamHostBaseDomain)
    || (input.mode === 'local' && localCorsOrigins.has(normalizedOrigin))
  )
}

export const createCorsOriginChecker = (input: {
  allowedOrigins: Set<string>
  mode: AppConfig['mode']
  teamHostBaseDomain?: string | undefined
}): NonNullable<FastifyCorsOptions['origin']> =>
  (origin, callback) => {
    callback(null, isOriginAllowed({
      origin: origin ?? undefined,
      allowedOrigins: input.allowedOrigins,
      mode: input.mode,
      teamHostBaseDomain: input.teamHostBaseDomain,
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
