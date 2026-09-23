import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import { parseOrganizationId, parseTeamId, type AuthorizedActionContext } from '@nessie/schemas'

import { registerTriggerRoutes } from '../src/routes/triggers.js'

// A `ticket_changed` trigger is refused field by field: both the create and
// the update route answer 400 `TRIGGER_CONFIG_REFUSED` with the first field as
// `error.field` and every refusal in `error.details`, instead of the generic
// "Trigger configuration is invalid" the other types keep.

const AGENT_ID = '31000000-0000-4000-8000-000000000001'
const CHANNEL_ID = '31000000-0000-4000-8000-000000000003'
const ORGANIZATION_ID = '31000000-0000-4000-8000-000000000005'
const TRIGGER_ID = '31000000-0000-4000-8000-000000000007'

const actorContext: AuthorizedActionContext = {
  actor: { actorId: '31000000-0000-4000-8000-000000000004', actorType: 'user', roles: ['owner'] },
  actionContext: { requestId: 'trigger-config-refusal' },
  tenant: {
    organizationId: parseOrganizationId(ORGANIZATION_ID),
    teamId: parseTeamId('31000000-0000-4000-8000-000000000006'),
  },
}

const triggerRow = {
  agentId: AGENT_ID,
  config: {},
  createdAt: new Date(0),
  description: null,
  enabled: true,
  id: TRIGGER_ID,
  lastFiredAt: null,
  name: 'Pick up tickets',
  nextRunAt: null,
  status: 'active',
  targetChannelId: CHANNEL_ID,
  targetThreadId: null,
  type: 'ticket_changed',
  updatedAt: new Date(0),
  workflowInstallationId: null,
}

const agent = { agentKind: 'shared', id: AGENT_ID, name: 'CTO', organizationId: ORGANIZATION_ID, systemSlug: null }

// Just enough of Prisma for the refusal: the agent exists, and the channel
// the trigger names does not. Nothing is ever written.
const tx = {
  agent: { findUnique: async () => agent },
  channel: { findFirst: async () => null },
}
const prisma = {
  $transaction: async (run: (client: typeof tx) => Promise<unknown>) => run(tx),
  agent: { findUnique: async () => agent },
  agentTrigger: {
    create: async () => assert.fail('a refused trigger is never written'),
    findFirst: async () => triggerRow,
    update: async () => assert.fail('a refused trigger is never written'),
  },
} as unknown as PrismaClient

const buildApp = () => {
  const app = Fastify({ logger: false })
  registerTriggerRoutes(app, {
    isAgentAccessibleToActor: async () => true,
    isTriggerAccessibleToActor: async () => true,
    prisma,
    requireActorContext: () => actorContext,
    requireOwner: () => true,
    requireUserActor: () => true,
  } as unknown as Parameters<typeof registerTriggerRoutes>[1])
  return app
}

const REFUSAL = { path: 'targetChannelId', reason: 'no such channel in this organisation' }

test('creating and editing a ticket trigger answer its refusal field by field', async () => {
  const app = buildApp()
  try {
    const config = { instructions: { general: 'Read the ticket first.' } }
    for (const [method, url] of [
      ['POST', `/api/agents/${AGENT_ID}/triggers`],
      ['PUT', `/api/triggers/${TRIGGER_ID}`],
    ] as const) {
      const response = await app.inject({
        method,
        payload: method === 'POST' ? { config, targetChannelId: CHANNEL_ID, type: 'ticket_changed' } : { config },
        url,
      })
      assert.equal(response.statusCode, 400, `${method} ${url}`)
      const body = response.json() as {
        error: { code: string; details: { refusals: unknown[] }; field: string; message: string }
      }
      assert.equal(body.error.code, 'TRIGGER_CONFIG_REFUSED')
      assert.equal(body.error.message, 'targetChannelId: no such channel in this organisation')
      assert.equal(body.error.field, 'targetChannelId')
      assert.deepEqual(body.error.details.refusals, [REFUSAL])
    }
  } finally {
    await app.close()
  }
})
