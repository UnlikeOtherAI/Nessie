import crypto from 'node:crypto'

/**
 * UnlikeOtherAuthenticator (UOA) deployment settings and the backend-channel
 * credential derived from them. Moved here from `api/src/services/uoa-auth.ts`
 * because the worker's personal-assistant tools call the same UOA org API the
 * routes call (`uoa-org-roster.ts`), and `api/src/services/*` is unreachable
 * from the worker. The api re-exports these, so both sides resolve the same
 * environment the same way.
 *
 * Only resolution and the client hash live here. The config-JWT builder, the
 * authorize URL, and everything else about the login flow stay in the api —
 * the worker never drives a browser through SSO.
 */

export type UoaSettings = {
  baseUrl: string
  domain: string
  configUrl: string
  jwksUrl: string
  redirectUrl: string
  contactEmail: string
  privateKeyPem: string
  kid: string
  clientSecret: string
}

const requireEnv = (name: string): string => {
  const value = process.env[name]
  if (!value || value.trim().length === 0) {
    throw new Error(`[uoa] ${name} is not set`)
  }
  return value
}

/**
 * Load UOA settings from the environment. The private key is provided base64 to
 * keep the PEM on a single line (docker compose env_file cannot carry multiline
 * values). `UOA_CLIENT_SECRET` may be empty until the integration is approved —
 * the authorize step (onboarding) does not need it; only token exchange does.
 */
export const loadUoaSettings = (): UoaSettings => ({
  baseUrl: (process.env.UOA_BASE_URL ?? 'https://authentication.unlikeotherai.com').replace(/\/$/, ''),
  domain: requireEnv('UOA_DOMAIN'),
  configUrl: requireEnv('UOA_CONFIG_URL'),
  jwksUrl: requireEnv('UOA_JWKS_URL'),
  redirectUrl: requireEnv('UOA_REDIRECT_URL'),
  contactEmail: process.env.UOA_CONTACT_EMAIL ?? '',
  privateKeyPem: Buffer.from(requireEnv('UOA_CONFIG_JWT_PRIVATE_KEY_B64'), 'base64').toString('utf8'),
  kid: requireEnv('UOA_CONFIG_JWT_KID'),
  clientSecret: process.env.UOA_CLIENT_SECRET ?? '',
})

export const isUoaConfigured = (): boolean => {
  try {
    loadUoaSettings()
    return true
  } catch {
    return false
  }
}

/** SHA256(domain + clientSecret) hex — UOA's bearer credential for token exchange. */
export const clientHash = (settings: UoaSettings): string =>
  crypto.createHash('sha256').update(settings.domain + settings.clientSecret).digest('hex')
