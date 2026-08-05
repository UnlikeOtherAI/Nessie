import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'

import { registerAuthRoutes } from '../src/routes/auth.js'

const userId = '00000000-0000-4000-8000-00000000000a'
const organizationId = '00000000-0000-4000-8000-000000000001'
const projectId = '00000000-0000-4000-8000-000000000002'
const teamId = '00000000-0000-4000-8000-000000000003'

const claims = {
  sub: userId,
  org: organizationId,
  proj: projectId,
  team: teamId,
  roles: ['owner'],
  providerId: 'local',
  providerType: 'local-bootstrap',
  sid: 'session-1',
  iat: 1700000000,
  exp: 1700086400,
}

/**
 * Drives the real PATCH /api/auth/me/preferences handler with a Prisma double.
 * `stored` is the single source of truth: the mocked authenticateRequest reads
 * it as the merge base and user.update writes it back, mirroring a row.
 */
const makeApp = (initialPreferences: Record<string, unknown>) => {
  const state = { stored: initialPreferences }

  const prisma = {
    user: {
      update: async ({ data }: { data: { preferences: Record<string, unknown> } }) => {
        state.stored = data.preferences
        return { id: userId, email: 'owner@example.com', displayName: 'Owner', preferences: state.stored }
      },
    },
    organizationMember: { findMany: async () => [] },
    projectMember: { findMany: async () => [] },
    teamMember: { findMany: async () => [] },
  } as unknown as PrismaClient

  const app = Fastify({ logger: false })
  registerAuthRoutes(app, {
    prisma,
    config: { mode: 'local', auth: { autoRedirectToSso: false } },
    authenticateRequest: async () => ({
      me: { user: { preferences: state.stored } },
      claims,
    }),
  } as unknown as Parameters<typeof registerAuthRoutes>[1])

  return { app, state }
}

test('PATCH /api/auth/me/preferences merges the push slice without dropping appearance keys', async () => {
  const { app, state } = makeApp({ theme: 'nebula', fontScale: 'medium' })

  const response = await app.inject({
    method: 'PATCH',
    url: '/api/auth/me/preferences',
    payload: {
      pushEnabled: false,
      pushQuietHours: { start: '22:00', end: '07:00', timezone: 'Europe/London' },
    },
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(state.stored, {
    theme: 'nebula',
    fontScale: 'medium',
    pushEnabled: false,
    pushQuietHours: { start: '22:00', end: '07:00', timezone: 'Europe/London' },
  })
  assert.deepEqual(response.json().data.user.preferences, state.stored)
  await app.close()
})

test('PATCH /api/auth/me/preferences clears a key when sent as null', async () => {
  const { app, state } = makeApp({
    theme: 'forest',
    pushEnabled: true,
    pushQuietHours: { start: '22:00', end: '07:00', timezone: 'Europe/London' },
  })

  const response = await app.inject({
    method: 'PATCH',
    url: '/api/auth/me/preferences',
    payload: { pushQuietHours: null },
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(state.stored, { theme: 'forest', pushEnabled: true })
  await app.close()
})

test('PATCH /api/auth/me/preferences sets only the fontScale slice, preserving push', async () => {
  const { app, state } = makeApp({ pushEnabled: false, theme: 'ocean' })

  const response = await app.inject({
    method: 'PATCH',
    url: '/api/auth/me/preferences',
    payload: { fontScale: 'large' },
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(state.stored, { pushEnabled: false, theme: 'ocean', fontScale: 'large' })
  await app.close()
})
