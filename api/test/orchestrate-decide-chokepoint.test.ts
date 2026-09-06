import assert from 'node:assert/strict'
import test from 'node:test'

import type { Prisma } from '@prisma/client'
import { enqueueOrchestrateDecide } from '@nessie/db'
import type { AuthorizedActionContext, OrchestrateDecideJobPayload } from '@nessie/schemas'

/**
 * The one place the delegated identity a single-member system DM implies is
 * stamped, exercised through the export both processes now call.
 *
 * The worker's `send_message` tool used to enqueue `orchestrate.decide` itself
 * and stamp `effectiveUserId` with the *current* run's acting user
 * unconditionally — a different rule from the destination-conditional one the
 * three api wake paths follow, and one that did not recognise `system_agent`
 * as a delegated surface at all. Both halves are asserted here: the stamp
 * appears for either delegated system DM type, and for nothing else.
 */

const ORGANIZATION_ID = '30000000-0000-4000-8000-000000000001'
const CHANNEL_ID = '30000000-0000-4000-8000-000000000002'
const THREAD_ID = '30000000-0000-4000-8000-000000000003'
const MESSAGE_ID = '30000000-0000-4000-8000-000000000004'
const USER_ID = '30000000-0000-4000-8000-000000000005'
const AGENT_ID = '30000000-0000-4000-8000-000000000006'

const actorContext = {
  actor: { actorId: USER_ID, actorType: 'user', roles: ['member'] },
  actionContext: { requestId: 'chokepoint-test' },
  tenant: { organizationId: ORGANIZATION_ID },
} as unknown as AuthorizedActionContext

const payload = {
  actorContext,
  channelAgents: [{ id: AGENT_ID, name: 'Agent', role: 'assistant', systemPrompt: '' }],
  channelId: CHANNEL_ID,
  content: 'hello',
  messageId: MESSAGE_ID,
  role: 'user',
  threadId: THREAD_ID,
} as unknown as OrchestrateDecideJobPayload

/**
 * `enqueueQueueJob` inserts through `$executeRaw` with a tagged template, so
 * the enqueued payload is one of the interpolated values — read it back rather
 * than stubbing the insert, which would stop testing the thing that ships.
 */
const enqueueAgainst = async (
  systemChannelType: string | null,
): Promise<Record<string, unknown>> => {
  let encodedPayload: string | null = null
  const prisma = {
    channel: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        assert.equal(where.id, CHANNEL_ID, 'the chokepoint resolves the destination itself')
        return { systemChannelType }
      },
    },
    $executeRaw: async (query: Prisma.Sql) => {
      const jsonValue = query.values.find(
        (value): value is string =>
          typeof value === 'string' && value.startsWith('{') && value.includes('actorContext'),
      )
      encodedPayload = jsonValue ?? null
      return 1
    },
  }

  const enqueued = await enqueueOrchestrateDecide(
    prisma as never,
    payload,
    `orchestrate:${MESSAGE_ID}`,
  )
  assert.equal(enqueued, true)
  assert.ok(encodedPayload, 'the job payload reached the insert')
  return JSON.parse(encodedPayload) as Record<string, unknown>
}

const effectiveUserIdOf = (job: Record<string, unknown>): string | undefined => {
  const context = job['actorContext'] as { actionContext?: { effectiveUserId?: string } }
  return context.actionContext?.effectiveUserId
}

test('a personal_assistant destination is stamped with its one member', async () => {
  const job = await enqueueAgainst('personal_assistant')
  assert.equal(effectiveUserIdOf(job), USER_ID)
})

test('a system_agent destination is stamped with its one member', async () => {
  // The second delegated system DM type. The worker's own enqueue recognised
  // only `personal_assistant`, so a global agent's home DM lost every
  // identity-delegated tool exactly the way the agent-card press once did.
  const job = await enqueueAgainst('system_agent')
  assert.equal(effectiveUserIdOf(job), USER_ID)
})

test('a plain channel destination is not stamped', async () => {
  const job = await enqueueAgainst(null)
  assert.equal(effectiveUserIdOf(job), undefined)
})
