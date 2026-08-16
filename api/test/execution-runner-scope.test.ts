import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import Fastify from 'fastify'

import { registerExecutionEnvironmentRoutes } from '../src/routes/execution-environments.js'

/**
 * `GET /api/execution-runners` used to return every runner with
 * `organizationId: null` alongside the caller's own. Those are the instance's
 * shared host fleet — hostnames, capacity and heartbeats belonging to no tenant
 * — so an organisation owner reading them was reading instance state. The fleet
 * moved behind `User.superAdmin`, the same boundary `GET /api/ops/health` and
 * the `organizationId: null` catalog arm draw; the org's own runners are
 * unchanged.
 */

const organizationId = '00000000-0000-4000-8000-0000000000a1'
const ownerId = '00000000-0000-4000-8000-0000000000a2'

const ownRunner = {
  id: '00000000-0000-4000-8000-0000000000b1',
  organizationId,
  label: 'tenant-runner',
  provider: 'docker' as const,
  status: 'active' as const,
  capabilities: {},
  heartbeatAt: null,
  metadata: {},
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  updatedAt: new Date('2026-08-01T00:00:00.000Z'),
}

const sharedRunner = {
  ...ownRunner,
  id: '00000000-0000-4000-8000-0000000000b2',
  organizationId: null,
  label: 'instance-host-runner',
}

type RunnerQuery = { where: Record<string, unknown> }

const makeApp = (superAdmin: boolean) => {
  const queries: RunnerQuery[] = []
  const prisma = {
    executionRunner: {
      findMany: async (args: RunnerQuery) => {
        queries.push(args)
        const where = args.where as {
          OR?: Array<Record<string, unknown>>
          organizationId?: string
        }
        return where.OR ? [ownRunner, sharedRunner] : [ownRunner]
      },
    },
    user: {
      findUnique: async () => ({ superAdmin }),
    },
  } as unknown as PrismaClient
  const actorContext: AuthorizedActionContext = {
    actionContext: { requestId: 'request-execution-runners' },
    actor: { actorId: ownerId, actorType: 'user', roles: ['owner'] },
    tenant: { organizationId },
  } as unknown as AuthorizedActionContext
  const app = Fastify({ logger: false })
  registerExecutionEnvironmentRoutes(app, {
    prisma,
    requireActorContext: () => actorContext,
    requireOwner: () => true,
  } as unknown as Parameters<typeof registerExecutionEnvironmentRoutes>[1])
  return { app, queries }
}

test('an organisation owner sees only their own runners, never the instance fleet', async () => {
  const { app, queries } = makeApp(false)
  const response = await app.inject({ method: 'GET', url: '/api/execution-runners' })
  assert.equal(response.statusCode, 200)
  const names = (response.json().data as Array<{ label: string }>).map((r) => r.label)
  assert.deepEqual(names, ['tenant-runner'])
  // The narrowing is in the query, not a post-filter: a shared runner is never
  // read in the first place.
  assert.deepEqual(queries[0]?.where, { organizationId })
})

test('a super-admin sees the shared host fleet alongside the organisation runners', async () => {
  const { app, queries } = makeApp(true)
  const response = await app.inject({ method: 'GET', url: '/api/execution-runners' })
  assert.equal(response.statusCode, 200)
  const names = (response.json().data as Array<{ label: string }>).map((r) => r.label)
  assert.deepEqual(names, ['tenant-runner', 'instance-host-runner'])
  assert.deepEqual(queries[0]?.where, {
    OR: [{ organizationId }, { organizationId: null }],
  })
})

test('a non-owner is refused before any runner is read', async () => {
  const prisma = {
    executionRunner: {
      findMany: async () => {
        throw new Error('runners must not be read for a non-owner')
      },
    },
    user: {
      findUnique: async () => {
        throw new Error('super-admin must not be resolved for a non-owner')
      },
    },
  } as unknown as PrismaClient
  const app = Fastify({ logger: false })
  registerExecutionEnvironmentRoutes(app, {
    prisma,
    requireActorContext: () => ({
      actionContext: { requestId: 'request-execution-runners-member' },
      actor: { actorId: ownerId, actorType: 'user', roles: ['member'] },
      tenant: { organizationId },
    }) as unknown as AuthorizedActionContext,
    requireOwner: (_context: unknown, reply: { code: (n: number) => { send: (b: unknown) => void } }) => {
      reply.code(403).send({ error: { code: 'FORBIDDEN' } })
      return false
    },
  } as unknown as Parameters<typeof registerExecutionEnvironmentRoutes>[1])

  const response = await app.inject({ method: 'GET', url: '/api/execution-runners' })
  assert.equal(response.statusCode, 403)
})
