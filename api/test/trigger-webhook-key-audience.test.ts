import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { mapTriggerRecord, TRIGGER_ADMIN_AUDIENCE } from '@nessie/team-admin'

import { dispatchAgentTrigger } from '../src/services/trigger-dispatch.js'
import {
  listAgentTriggers,
  listWorkflowInstallationTriggers,
} from '../src/services/trigger-crud.js'

// The webhook intake key is a bearer credential: whoever holds it can post to
// the public intake endpoint forever, with no session. `POST /api/triggers/:id/
// fire` is member-level (requireUserActor, NOT requireOwner) and returns the
// mapped trigger record, so while the record always carried `webhookApiKey`
// every member who could fire a webhook trigger was handed its key.
//
// These tests pin the audience split: the presenter omits the key unless a
// caller explicitly asks for it, so a call site that does not think about
// audience fails closed.
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const WEBHOOK_KEY = 'ntk_00000000000000000000000000000001'

const presenterInput = {
  agentId: null,
  config: { apiKey: WEBHOOK_KEY, secret: 'shh' },
  createdAt: new Date('2026-08-30T10:00:00.000Z'),
  description: null,
  enabled: true,
  id: randomUUID(),
  lastFiredAt: null,
  name: 'hook',
  nextRunAt: null,
  status: 'active' as const,
  targetChannelId: null,
  targetThreadId: null,
  type: 'webhook' as const,
  updatedAt: new Date('2026-08-30T10:00:00.000Z'),
  workflowInstallationId: null,
}

test('the presenter omits the webhook key unless the caller asks for it', () => {
  const anonymous = mapTriggerRecord(presenterInput)
  assert.equal(
    anonymous.webhookApiKey,
    undefined,
    'default audience must not carry the intake credential',
  )
  // The in-config copy was already redacted; that must not regress either.
  assert.equal((anonymous.config as Record<string, unknown>)['apiKey'], '[redacted]')
  assert.equal((anonymous.config as Record<string, unknown>)['secret'], '[redacted]')

  const administered = mapTriggerRecord(presenterInput, TRIGGER_ADMIN_AUDIENCE)
  assert.equal(
    administered.webhookApiKey,
    WEBHOOK_KEY,
    'owner-administered surfaces still reveal the key they minted',
  )
})

type Seed = {
  agentId: string
  channelId: string
  organizationId: string
  triggerId: string
}

const seedWebhookTrigger = async (prisma: PrismaClient): Promise<Seed> => {
  const org = await prisma.organization.create({ data: { name: `trg-key ${randomUUID()}` } })
  const project = await prisma.project.create({
    data: { name: 'p', organizationId: org.id },
  })
  const team = await prisma.team.create({ data: { name: 't', projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: 'c',
      slug: `c-${randomUUID()}`,
      organizationId: org.id,
      projectId: project.id,
      teamId: team.id,
    },
  })
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  const agent = await prisma.agent.create({ data: { name: 'A', organizationId: org.id } })
  await prisma.agentBinding.create({ data: { agentId: agent.id, channelId: channel.id } })
  const trigger = await prisma.agentTrigger.create({
    data: {
      agentId: agent.id,
      config: { apiKey: WEBHOOK_KEY },
      targetChannelId: channel.id,
      targetThreadId: thread.id,
      type: 'webhook',
    },
  })

  return {
    agentId: agent.id,
    channelId: channel.id,
    organizationId: org.id,
    triggerId: trigger.id,
  }
}

const cleanup = async (prisma: PrismaClient, seed: Seed): Promise<void> => {
  // Scoped to this seed's own threads: `queue_jobs` is global and a
  // LIKE-matched delete would take rows a concurrent suite is about to count.
  await prisma.$executeRawUnsafe(
    'DELETE FROM queue_jobs WHERE payload->>\'threadId\' IN '
    + '(SELECT id::text FROM threads WHERE channel_id = $1::uuid)',
    seed.channelId,
  )
  await prisma.organization.delete({ where: { id: seed.organizationId } })
}

runDatabaseTest('firing a webhook trigger never returns its intake key', async () => {
  const prisma = new PrismaClient()
  const seed = await seedWebhookTrigger(prisma)

  try {
    const dispatched = await dispatchAgentTrigger(prisma, {
      dedupeKey: `manual:${randomUUID()}`,
      payload: { hello: 'world' },
      source: 'manual',
      triggerId: seed.triggerId,
    })

    assert.notEqual(dispatched.kind, 'rejected', 'the fire should be accepted')
    if (dispatched.kind === 'rejected') return

    assert.equal(
      dispatched.trigger.webhookApiKey,
      undefined,
      'the member-reachable fire response must not carry the intake credential',
    )
    assert.equal(
      (dispatched.trigger.config as Record<string, unknown>)['apiKey'],
      '[redacted]',
    )

    // The owner-gated list is where the key legitimately still appears, so the
    // fix is an audience split rather than a blanket removal.
    const owned = await listAgentTriggers(prisma, seed.agentId)
    assert.equal(owned[0]?.webhookApiKey, WEBHOOK_KEY)
  } finally {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  }
})

runDatabaseTest('the workflow-installation trigger list withholds intake keys', async () => {
  const prisma = new PrismaClient()
  const org = await prisma.organization.create({ data: { name: `trg-wf ${randomUUID()}` } })

  try {
    const installation = await prisma.workflowInstallation.findFirst({
      where: { organizationId: org.id },
      select: { id: true },
    })
    // No installation to seed against on a bare database: the presenter-level
    // assertion above already pins the default, so skip rather than fabricate
    // a half-valid installation graph.
    if (!installation) return

    const triggers = await listWorkflowInstallationTriggers(prisma, installation.id)
    for (const trigger of triggers) {
      assert.equal(trigger.webhookApiKey, undefined)
    }
  } finally {
    await prisma.organization.delete({ where: { id: org.id } })
    await prisma.$disconnect()
  }
})
