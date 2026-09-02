import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import type { AgentMailConfig, AgentMailTransport, SesInboundReceipt } from '@nessie/agent-mail'
import type { FileService, PgRealtimeTransport } from '@nessie/runtime'

import { processInboundReceipt } from '../../src/control/agent-email/inbound.js'
import { assertGlobalQueuesQuiet, deleteThreadQueueJobs, runDatabaseTest } from './support.js'

/**
 * Inbound email against the real database.
 *
 * The properties under test only exist in Postgres: the receipt-id claim that
 * makes an SNS retry a no-op, and the run dispatch that rides the same
 * per-(agent, thread) claim as chat. `processInboundReceipt` reaches
 * `claimThreadRunOrPend`, which is one of the global pollers' invariants, so
 * this file lives beside the other DB suites and takes the same preflight.
 */

type Seed = {
  organizationId: string
  projectId: string
  teamId: string
  channelId: string
  agentId: string
  mailboxId: string
  address: string
}

const seedMailbox = async (prisma: PrismaClient): Promise<Seed> => {
  const org = await prisma.organization.create({ data: { name: `mail ${randomUUID()}` } })
  const project = await prisma.project.create({
    data: { name: 'p', organizationId: org.id },
  })
  const team = await prisma.team.create({ data: { name: 't', projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: 'mailbox',
      organizationId: org.id,
      projectId: project.id,
      slug: `mbx-${randomUUID()}`,
      systemChannelType: 'agent_email',
      teamId: team.id,
    },
  })
  const agent = await prisma.agent.create({
    data: { name: 'Support', organizationId: org.id, role: 'assistant' },
  })
  await prisma.agentBinding.create({ data: { agentId: agent.id, channelId: channel.id } })
  const address = `support-${randomUUID().slice(0, 8)}@nessie.works`
  const mailbox = await prisma.agentMailbox.create({
    data: {
      address,
      agentId: agent.id,
      channelId: channel.id,
      organizationId: org.id,
    },
  })
  return {
    address,
    agentId: agent.id,
    channelId: channel.id,
    mailboxId: mailbox.id,
    organizationId: org.id,
    projectId: project.id,
    teamId: team.id,
  }
}

const cleanup = async (prisma: PrismaClient, seed: Seed): Promise<void> => {
  const threads = await prisma.thread.findMany({
    select: { id: true },
    where: { channelId: seed.channelId },
  })
  for (const thread of threads) await deleteThreadQueueJobs(prisma, thread.id)
  await prisma.organization.delete({ where: { id: seed.organizationId } }).catch(() => undefined)
}

const rawMessage = (input: {
  from: string
  to: string
  subject: string
  messageId: string
  extraHeaders?: string[]
}): string =>
  [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    `Message-ID: <${input.messageId}>`,
    ...(input.extraHeaders ?? []),
    '',
    'Body text.',
  ].join('\r\n')

const config: AgentMailConfig = {
  customDomains: false,
  domain: 'nessie.works',
  inboundBucket: 'mail',
  inboundPrefix: '',
  inboundRetentionDays: 30,
  maxInboundBytes: 25 * 1024 * 1024,
  maxSendsPerHour: 30,
  sesRegion: 'eu-west-1',
  snsTopicArn: 'arn:aws:sns:eu-west-1:1:mail',
}

const makeTransport = (raw: string): AgentMailTransport =>
  ({
    createDomainIdentity: async () => ({ dkimTokens: [] }),
    deleteInboundObject: async () => undefined,
    getDomainIdentity: async () => null,
    getInboundObject: async () => Buffer.from(raw, 'utf8'),
    headInboundObject: async () => ({ contentLength: Buffer.byteLength(raw) }),
    sendRaw: async () => ({ sesMessageId: 'ses-out' }),
  }) as AgentMailTransport

const noopFiles = { store: async () => ({ attachment: {}, bytesWritten: 0 }) } as unknown as FileService
const noopRealtime = { publishWs: async () => undefined } as unknown as PgRealtimeTransport

const receiptFor = (seed: Seed, sesMessageId: string, recipients?: string[]): SesInboundReceipt => ({
  envelopeFrom: 'petra@example.com',
  envelopeRecipients: recipients ?? [seed.address],
  kind: 'inbound',
  receivedAt: new Date().toISOString(),
  s3Bucket: 'mail',
  s3ObjectKey: `inbound/${sesMessageId}`,
  sesMessageId,
  verdicts: { dkim: 'PASS', dmarc: 'PASS', spam: 'PASS', spf: 'PASS', virus: 'PASS' },
})

runDatabaseTest('an inbound email stores a message and wakes exactly one run', async () => {
  const prisma = new PrismaClient()
  await assertGlobalQueuesQuiet(prisma)
  const seed = await seedMailbox(prisma)
  try {
    const raw = rawMessage({
      from: 'Petra <petra@example.com>',
      messageId: 'm1@example.com',
      subject: 'Invoice question',
      to: seed.address,
    })
    const deps = {
      config,
      files: noopFiles,
      prisma,
      realtimeTransport: noopRealtime,
      transport: makeTransport(raw),
    }

    const first = await processInboundReceipt(deps, receiptFor(seed, 'ses-1'))
    assert.deepEqual(
      first.map((outcome) => outcome.status),
      ['delivered'],
    )
    assert.equal(first[0]?.status === 'delivered' && first[0].woke, true)

    const stored = await prisma.emailMessage.findMany({ where: { mailboxId: seed.mailboxId } })
    assert.equal(stored.length, 1)
    assert.equal(stored[0]?.subject, 'Invoice question')
    assert.equal(stored[0]?.fromAddress, 'petra@example.com')

    const runs = await prisma.run.findMany({ where: { agentId: seed.agentId } })
    assert.equal(runs.length, 1, 'exactly one run for one email')

    // The SNS retry. Same receipt, same everything.
    const replay = await processInboundReceipt(deps, receiptFor(seed, 'ses-1'))
    assert.deepEqual(
      replay.map((outcome) => outcome.status),
      ['duplicate'],
      'a retried delivery loses the claim',
    )
    assert.equal(
      await prisma.emailMessage.count({ where: { mailboxId: seed.mailboxId } }),
      1,
      'no second stored message',
    )
    assert.equal(
      await prisma.run.count({ where: { agentId: seed.agentId } }),
      1,
      'and no second run — persist-and-wake is one decision',
    )
  } finally {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  }
})

runDatabaseTest('routing follows the SES envelope, never the MIME headers', async () => {
  const prisma = new PrismaClient()
  await assertGlobalQueuesQuiet(prisma)
  const seed = await seedMailbox(prisma)
  try {
    // The sender addressed the visible headers to somebody else entirely and
    // reached this mailbox by Bcc. Routing on `To:` would drop the message;
    // routing on a forged `To:` would deliver it to another tenant.
    const raw = rawMessage({
      from: 'petra@example.com',
      messageId: 'm2@example.com',
      subject: 'Blind copy',
      to: 'someone-else@other-tenant.example',
    })
    const deps = {
      config,
      files: noopFiles,
      prisma,
      realtimeTransport: noopRealtime,
      transport: makeTransport(raw),
    }

    const outcomes = await processInboundReceipt(deps, receiptFor(seed, 'ses-2'))
    assert.deepEqual(outcomes.map((outcome) => outcome.status), ['delivered'])

    const stored = await prisma.emailMessage.findFirst({ where: { mailboxId: seed.mailboxId } })
    assert.equal(stored?.subject, 'Blind copy')
    assert.deepEqual(
      stored?.envelopeRecipients,
      [seed.address],
      'the envelope is what was recorded as the routing truth',
    )
    assert.deepEqual(
      stored?.toAddresses,
      ['someone-else@other-tenant.example'],
      'the header is kept for display only',
    )
  } finally {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a delivery report is stored but spends no run', async () => {
  const prisma = new PrismaClient()
  await assertGlobalQueuesQuiet(prisma)
  const seed = await seedMailbox(prisma)
  try {
    const raw = rawMessage({
      extraHeaders: ['Auto-Submitted: auto-replied'],
      from: 'mailer-daemon@example.com',
      messageId: 'm3@example.com',
      subject: 'Undelivered Mail Returned to Sender',
      to: seed.address,
    })
    const deps = {
      config,
      files: noopFiles,
      prisma,
      realtimeTransport: noopRealtime,
      transport: makeTransport(raw),
    }

    const outcomes = await processInboundReceipt(deps, receiptFor(seed, 'ses-3'))
    assert.equal(outcomes[0]?.status === 'delivered' && outcomes[0].woke, false)
    assert.equal(
      await prisma.emailMessage.count({ where: { mailboxId: seed.mailboxId } }),
      1,
      'still readable in the mailbox',
    )
    assert.equal(
      await prisma.run.count({ where: { agentId: seed.agentId } }),
      0,
      'answering a bounce notice is how mail loops start',
    )
  } finally {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a failed virus verdict stores the mail without waking the agent', async () => {
  const prisma = new PrismaClient()
  await assertGlobalQueuesQuiet(prisma)
  const seed = await seedMailbox(prisma)
  try {
    const raw = rawMessage({
      from: 'attacker@example.com',
      messageId: 'm4@example.com',
      subject: 'Invoice.zip',
      to: seed.address,
    })
    const receipt = receiptFor(seed, 'ses-4')
    receipt.verdicts = { ...receipt.verdicts, virus: 'FAIL' }
    const outcomes = await processInboundReceipt(
      {
        config,
        files: noopFiles,
        prisma,
        realtimeTransport: noopRealtime,
        transport: makeTransport(raw),
      },
      receipt,
    )
    assert.equal(outcomes[0]?.status === 'delivered' && outcomes[0].woke, false)
    assert.equal(await prisma.run.count({ where: { agentId: seed.agentId } }), 0)
  } finally {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a reply joins its conversation; a forged reference starts a new one', async () => {
  const prisma = new PrismaClient()
  await assertGlobalQueuesQuiet(prisma)
  const seed = await seedMailbox(prisma)
  try {
    const deps = (raw: string) => ({
      config,
      files: noopFiles,
      prisma,
      realtimeTransport: noopRealtime,
      transport: makeTransport(raw),
    })

    await processInboundReceipt(
      deps(rawMessage({
        from: 'petra@example.com',
        messageId: 'root@example.com',
        subject: 'Thread root',
        to: seed.address,
      })),
      receiptFor(seed, 'ses-5'),
    )

    await processInboundReceipt(
      deps(rawMessage({
        extraHeaders: ['In-Reply-To: <root@example.com>', 'References: <root@example.com>'],
        from: 'petra@example.com',
        messageId: 'reply@example.com',
        subject: 'Re: Thread root',
        to: seed.address,
      })),
      receiptFor(seed, 'ses-6'),
    )

    assert.equal(
      await prisma.emailConversation.count({ where: { mailboxId: seed.mailboxId } }),
      1,
      'the reply joined the conversation it named',
    )

    // An id this mailbox has never seen: a stranger cannot graft themselves
    // onto an existing correspondence by writing its Message-ID in a header.
    await processInboundReceipt(
      deps(rawMessage({
        extraHeaders: ['In-Reply-To: <victim-thread@other-tenant.example>'],
        from: 'stranger@example.com',
        messageId: 'forged@example.com',
        subject: 'Re: something you never sent',
        to: seed.address,
      })),
      receiptFor(seed, 'ses-7'),
    )
    assert.equal(
      await prisma.emailConversation.count({ where: { mailboxId: seed.mailboxId } }),
      2,
      'a forged reference degrades to a new conversation rather than mis-merging',
    )
  } finally {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  }
})

runDatabaseTest('mail to an address nobody claimed is dropped, not bounced', async () => {
  const prisma = new PrismaClient()
  await assertGlobalQueuesQuiet(prisma)
  const seed = await seedMailbox(prisma)
  try {
    const raw = rawMessage({
      from: 'petra@example.com',
      messageId: 'm8@example.com',
      subject: 'Hello?',
      to: 'nobody@nessie.works',
    })
    const outcomes = await processInboundReceipt(
      {
        config,
        files: noopFiles,
        prisma,
        realtimeTransport: noopRealtime,
        transport: makeTransport(raw),
      },
      receiptFor(seed, 'ses-8', ['nobody@nessie.works']),
    )
    assert.deepEqual(outcomes.map((outcome) => outcome.status), ['no_mailbox'])
    assert.equal(await prisma.emailMessage.count({ where: { mailboxId: seed.mailboxId } }), 0)
  } finally {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  }
})
