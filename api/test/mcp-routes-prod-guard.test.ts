import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'

import type { PrismaClient } from '@prisma/client'

import { registerMcpRoutes } from '../src/routes/mcp.js'
import type { SecretStore } from '../src/services/mcp-oauth.js'

/**
 * Task #38 — production-guard coverage for `registerMcpRoutes`.
 *
 * The default `inMemorySecretStoreStub` mints opaque refs but never persists
 * token material. If we silently fall back to it in production, an OAuth
 * handshake completes "successfully" yet the access/refresh tokens are
 * dropped on the floor. These tests pin the contract:
 *
 *   1. `NODE_ENV=production` + no `oauthSecretStore` → throw at startup.
 *   2. `NODE_ENV != production` + no `oauthSecretStore` → loud warn, fall back.
 *   3. Explicit `oauthSecretStore` overrides the guard in any environment.
 */

const makeRouteHelpers = () => {
  // The guard runs before any prisma access, so an empty object is enough.
  return {
    prisma: {} as unknown as PrismaClient,
    requireActorContext: () => null,
    requireOwner: () => false,
  }
}

test('registerMcpRoutes throws when NODE_ENV=production and no SecretStore is wired', () => {
  const original = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    const app = Fastify({ logger: false })
    assert.throws(
      () => registerMcpRoutes(app, makeRouteHelpers()),
      /OAuth SecretStore not configured/,
    )
  } finally {
    if (original === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = original
  }
})

test('registerMcpRoutes falls back to stub with a loud warning outside production', () => {
  const original = process.env.NODE_ENV
  process.env.NODE_ENV = 'development'
  const warnings: string[] = []
  try {
    const app = Fastify({ logger: false })
    // Capture the loud warning emitted by the fallback path.
    app.log.warn = ((msg: unknown) => {
      warnings.push(typeof msg === 'string' ? msg : JSON.stringify(msg))
    }) as typeof app.log.warn
    registerMcpRoutes(app, makeRouteHelpers())
    assert.ok(
      warnings.some((w) => w.includes('No OAuth SecretStore configured')),
      `expected loud fallback warning, got: ${JSON.stringify(warnings)}`,
    )
  } finally {
    if (original === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = original
  }
})

test('registerMcpRoutes accepts an explicit SecretStore in production without throwing', () => {
  const original = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    const app = Fastify({ logger: false })
    const explicitStore: SecretStore = { put: async () => 'secret_explicit_1' }
    assert.doesNotThrow(() =>
      registerMcpRoutes(app, { ...makeRouteHelpers(), oauthSecretStore: explicitStore }),
    )
  } finally {
    if (original === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = original
  }
})
