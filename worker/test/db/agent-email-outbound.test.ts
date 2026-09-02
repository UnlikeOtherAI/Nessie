import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import type { AgentMailConfig, AgentMailTransport } from '@nessie/agent-mail'

import { sweepStuckSends } from '../../src/control/agent-email/delivery-events.js'
import {
  SendRateLimitedError,
  SuppressedRecipientError,
  queueOutboundEmail,
} from '../../src/control/agent-email/outbound.js'
import { runDatabaseTest } from './support.js'

/**
 * Outbound sending against the real database.
 *
 * The property that matters here cannot be tested with a fake: a duplicate
 * email is the one failure in this feature nobody can take back, and what
 * prevents it is a unique index. These drive the real writes.
 */

const config: AgentMailConfig = {
  customDomains: false,
  domain: 'nessie.works',
  inboundBucket: 'mail',
  inboundPrefix: '',
  inboundRetentionDays: 30,
  maxInboundBytes: 25 * 1024 * 1024,
  maxSendsPerHour: 3,
  sesRegion: 'eu-west-1',
  snsTopicArn: 'arn:aws:sns:eu-west-1:1:mail',
}

const transport = {
  createDomainIdentity: async () => ({ dkimTokens: [] }),
  deleteInboundObject: async () => undefined,
  getDomainIdentity: async () => null,
  getInboundObject: async () => Buffer.from(''),
  headInboundObject: async () => ({ contentLength: 0 }),
  sendRaw: async () => ({ sesMessageId: 'ses-1' }),
} as AgentMailTransport

const seedMailbox = async (prisma: PrismaClient) => {
  const org = await prisma.organization.create({ data: { name: `out ${randomUUID()}` } })
  const project = await prisma.project.create({ data: { name: 'p', organizationId: org.id } })
  const team = await prisma.team.create({ data: { name: 't', projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: 'mail',
      organizationId: org.id,
      projectId: project.id,
      slug: `mail-${randomUUID()}`,
      systemChannelType: 'agent_email',
      teamId: team.id,
    },
  })
  const agent = await prisma.agent.create({
    data: { name: 'Support', organizationId: org.id, role: 'assistant' },
  })
  const mailbox = await prisma.agentMailbox.create({
    data: {
      address: `out-${randomUUID().slice(0, 8)}@nessie.works`,
      agentId: agent.id,
      channelId: channel.id,
      organizationId: org.id,
    },
  })
  return { mailboxId: mailbox.id, organizationId: org.id }
}

const cleanup = async (prisma: PrismaClient, organizationId: string) => {
  const mailboxes = await prisma.agentMailbox.findMany({
    select: { channelId: true, id: true },
    where: { organizationId },
  })
  for (const mailbox of mailboxes) {
    await prisma.agentMailbox.delete({ where: { id: mailbox.id } })
    await prisma.channel.delete({ where: { id: mailbox.channelId } }).catch(() => undefined)
  }
  await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined)
}

runDatabaseTest('a replayed tool call adopts its queued send instead of minting a second', async () => {
  const prisma = new PrismaClient()
  const seed = await seedMailbox(prisma)
  try {
    const sendKey = `run-${randomUUID()}:call-1`
    const input = {
      mailboxId: seed.mailboxId,
      organizationId: seed.organizationId,
      sendKey,
      subject: 'Hello',
      text: 'first',
      to: ['petra@example.com'],
    }

    const first = await queueOutboundEmail({ config, prisma, transport }, input)
    // The same run replaying the same tool call — a different body, even.
    const replay = await queueOutboundEmail(
      { config, prisma, transport },
      { ...input, text: 'second' },
    )

    assert.equal(replay.id, first.id, 'the replay adopts the queued row')
    assert.equal(
      await prisma.emailMessage.count({
        where: { direction: 'outbound', mailboxId: seed.mailboxId },
      }),
      1,
      'exactly one message reaches the recipient',
    )
  } finally {
    await cleanup(prisma, seed.organizationId)
    await prisma.$disconnect()
  }
})

runDatabaseTest('two concurrent sends cannot both pass the last slot of the hourly cap', async () => {
  const prisma = new PrismaClient()
  const seed = await seedMailbox(prisma)
  try {
    const send = (n: number) =>
      queueOutboundEmail(
        { config, prisma, transport },
        {
          mailboxId: seed.mailboxId,
          organizationId: seed.organizationId,
          sendKey: `run-${randomUUID()}:call-${n}`,
          subject: `n${n}`,
          text: 'x',
          to: ['petra@example.com'],
        },
      )

    // maxSendsPerHour is 3 here; fill it, then fire two at once.
    await send(1)
    await send(2)
    await send(3)
    const results = await Promise.allSettled([send(4), send(5)])

    assert.equal(
      results.every(
        (r) => r.status === 'rejected' && r.reason instanceof SendRateLimitedError,
      ),
      true,
      'the cap is enforced inside the write, so neither racer slips through',
    )
    assert.equal(
      await prisma.emailMessage.count({
        where: { direction: 'outbound', mailboxId: seed.mailboxId },
      }),
      3,
    )
  } finally {
    await cleanup(prisma, seed.organizationId)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a suppressed recipient is refused by the write itself', async () => {
  const prisma = new PrismaClient()
  const seed = await seedMailbox(prisma)
  const address = `gone-${randomUUID().slice(0, 8)}@example.com`
  try {
    await prisma.emailSuppression.create({
      data: { address, occurredAt: new Date(), reason: 'permanent_bounce' },
    })

    // Deliberately calling the write directly, with no gate in front of it:
    // the refusal has to live here, not only in the caller.
    await assert.rejects(
      queueOutboundEmail(
        { config, prisma, transport },
        {
          mailboxId: seed.mailboxId,
          organizationId: seed.organizationId,
          sendKey: `run-${randomUUID()}:call-1`,
          subject: 'Hi',
          text: 'x',
          to: [address],
        },
      ),
      (error: unknown) => error instanceof SuppressedRecipientError,
    )
    assert.equal(
      await prisma.emailMessage.count({ where: { mailboxId: seed.mailboxId } }),
      0,
      'a refused send leaves no queued row behind',
    )
  } finally {
    await prisma.emailSuppression.deleteMany({ where: { address } })
    await cleanup(prisma, seed.organizationId)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a send whose worker died mid-claim resolves to delivery_unknown', async () => {
  const prisma = new PrismaClient()
  const seed = await seedMailbox(prisma)
  try {
    const queued = await queueOutboundEmail(
      { config, prisma, transport },
      {
        mailboxId: seed.mailboxId,
        organizationId: seed.organizationId,
        sendKey: `run-${randomUUID()}:call-1`,
        subject: 'Hi',
        text: 'x',
        to: ['petra@example.com'],
      },
    )
    // Exactly the state a killed worker leaves: claimed, never answered.
    await prisma.emailMessage.update({
      data: { deliveryState: 'sending', occurredAt: new Date(Date.now() - 60 * 60 * 1000) },
      where: { id: queued.id },
    })

    assert.equal(await sweepStuckSends(prisma), 1)
    const after = await prisma.emailMessage.findUniqueOrThrow({
      select: { deliveryState: true },
      where: { id: queued.id },
    })
    assert.equal(
      after.deliveryState,
      'delivery_unknown',
      'never back to queued — re-dispatching could duplicate a delivered message',
    )
  } finally {
    await cleanup(prisma, seed.organizationId)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a send still inside its claim window is left alone', async () => {
  const prisma = new PrismaClient()
  const seed = await seedMailbox(prisma)
  try {
    const queued = await queueOutboundEmail(
      { config, prisma, transport },
      {
        mailboxId: seed.mailboxId,
        organizationId: seed.organizationId,
        sendKey: `run-${randomUUID()}:call-1`,
        subject: 'Hi',
        text: 'x',
        to: ['petra@example.com'],
      },
    )
    await prisma.emailMessage.update({
      data: { deliveryState: 'sending' },
      where: { id: queued.id },
    })

    assert.equal(await sweepStuckSends(prisma), 0, 'a live dispatch keeps its claim')
  } finally {
    await cleanup(prisma, seed.organizationId)
    await prisma.$disconnect()
  }
})
