import type { FastifyReply, FastifyRequest } from 'fastify'
import type { NessieConfig } from '@nessie/config'

export const REFRESH_COOKIE_NAME = 'nessie_refresh'

// The refresh cookie is scoped to /api/auth (every mint, refresh, and logout
// route lives there) and never readable by JavaScript. In production the admin
// and API are different subdomains, so the cross-site request needs
// SameSite=None; Secure; locally they share an origin via the Vite proxy, where
// Lax over http is correct.
const cookieOptions = (config: NessieConfig) => ({
  httpOnly: true,
  secure: config.mode !== 'local',
  sameSite: (config.mode === 'local' ? 'lax' : 'none') as 'lax' | 'none',
  path: '/api/auth',
})

export const setRefreshCookie = (
  reply: FastifyReply,
  rawToken: string,
  config: NessieConfig,
  maxAgeSeconds: number,
): void => {
  reply.setCookie(REFRESH_COOKIE_NAME, rawToken, {
    ...cookieOptions(config),
    maxAge: maxAgeSeconds,
  })
}

export const clearRefreshCookie = (reply: FastifyReply, config: NessieConfig): void => {
  reply.clearCookie(REFRESH_COOKIE_NAME, cookieOptions(config))
}

export const readRefreshCookie = (request: FastifyRequest): string | null =>
  request.cookies?.[REFRESH_COOKIE_NAME] ?? null
