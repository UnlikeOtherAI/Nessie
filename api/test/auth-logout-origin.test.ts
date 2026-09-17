import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import cookie from '@fastify/cookie'
import type { PrismaClient } from '@prisma/client'
import Fastify from 'fastify'

import { issueSessionToken } from '../src/auth/session.js'
import { registerAuthLogoutRoute } from '../src/routes/auth-logout.js'

/**
 * Origin posture for `DELETE /api/auth/session` — the same rule the refresh
 * route already enforces, and the route that needs it most: logout is a
 * body-less DELETE, so no preflight ever runs, and the SameSite=None refresh
 * cookie (admin and API are sibling subdomains — deliberate) rides along on
 * a cross-site browser request. Unguarded, any page could force a logout
 * across devices.
 *
 * A present Origin must name an origin this deployment serves; an ABSENT
 * Origin must still pass — the CLI, the desktop app and curl send none, and
 * refusing them is the regression that would strand non-browser clients
 * unable to sign out. The revocation spy is what the assertions read: a
 * refused request must not revoke, an admitted one must.
 */

const AUTH_SECRET = 'logout-origin-test-secret'
const USER_ID = randomUUID()
const SESSION_ID = randomUUID()
const ALLOWED_ORIGIN = 'https://app.nessie.works'

const bearer = issueSessionToken({
  org: randomUUID(),
  proj: randomUUID(),
  providerId: 'uoa',
  providerType: 'uoa',
  roles: ['owner'],
  sub: USER_ID,
  team: randomUUID(),
  tv: 1,
}, AUTH_SECRET, 3600, SESSION_ID).token

const buildApp = async (
  revoked: string[],
  options: { withOriginPolicy: boolean } = { withOriginPolicy: true },
) => {
  const app = Fastify({ logger: false })
  await app.register(cookie)
  registerAuthLogoutRoute(app, {
    authSecret: AUTH_SECRET,
    getAuthorizationToken: (request) => {
      const header = request.headers.authorization
      return typeof header === 'string' ? header.replace(/^Bearer /, '') : null
    },
    prisma: {} as PrismaClient,
    ...(options.withOriginPolicy
      ? {
          originPolicy: {
            allowedOrigins: new Set([ALLOWED_ORIGIN]),
            mode: 'hosted',
            teamHostBaseDomain: undefined,
          },
        }
      : {}),
  }, {
    clearPresence: async () => undefined,
    revokeByRefreshToken: async () => null,
    revokeSession: async (_prisma, _userId, sessionId) => {
      revoked.push(sessionId)
      return 1
    },
  } as never)
  await app.ready()
  return app
}

const logout = (
  app: Awaited<ReturnType<typeof buildApp>>,
  origin?: string,
) =>
  app.inject({
    method: 'DELETE',
    url: '/api/auth/session',
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(origin ? { origin } : {}),
    },
  })

test('a present, unallowed Origin is refused and revokes nothing', async () => {
  const revoked: string[] = []
  const app = await buildApp(revoked)

  const response = await logout(app, 'https://evil.example')

  assert.equal(response.statusCode, 403)
  assert.equal(response.json().error.code, 'ORIGIN_FORBIDDEN')
  assert.deepEqual(revoked, [], 'the guard runs before any revocation work')
  await app.close()
})

test('an absent Origin still signs out (CLI, desktop, curl)', async () => {
  const revoked: string[] = []
  const app = await buildApp(revoked)

  const response = await logout(app)

  assert.equal(response.statusCode, 204)
  assert.deepEqual(revoked, [SESSION_ID])
  await app.close()
})

test('a present, allowed Origin signs out', async () => {
  const revoked: string[] = []
  const app = await buildApp(revoked)

  const response = await logout(app, ALLOWED_ORIGIN)

  assert.equal(response.statusCode, 204)
  assert.deepEqual(revoked, [SESSION_ID])
  await app.close()
})

test('a present Origin with no policy wired is refused, never silently honoured', async () => {
  const revoked: string[] = []
  // The composition-root obligation, pinned: a deployment that cannot vet a
  // browser origin must fail closed on credentialed browser requests, not
  // fall back to honouring them.
  const app = await buildApp(revoked, { withOriginPolicy: false })

  const response = await logout(app, ALLOWED_ORIGIN)

  assert.equal(response.statusCode, 403)
  assert.equal(response.json().error.code, 'ORIGIN_FORBIDDEN')
  assert.deepEqual(revoked, [])
  await app.close()
})
