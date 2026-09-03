import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { AgentMailboxError, createAgentMailbox, retireAgentMailbox } from '@nessie/team-admin'

import { runDatabaseTest } from './support.js'

/**
 * Mailbox creation against the real database.
 *
 * Every other suite seeds its channel and mailbox by hand, which is exactly how
 * a missing `slug` reached the browser: the service path hit
 * `channels_standard_slug_required` and every claim 500'd, while the fixtures
 * that set a slug themselves stayed green. These tests drive the real service,
 * so the storage invariants it must satisfy are actually exercised — the slug,
 * the `agent_email` arm of the channel surface constraint, and the atomicity of
 * the mailbox + channel + thread + binding it creates.
 */

const seedOrg = async (prisma: PrismaClient) => {
  const org = await prisma.organization.create({ data: { name: `mbx-create ${randomUUID()}` } })
  const project = await prisma.project.create({
    data: { name: 'p', organizationId: org.id },
  })
  const team = await prisma.team.create({ data: { name: 't', projectId: project.id } })
  const agent = await prisma.agent.create({
    data: {
      name: 'Support',
      organizationId: org.id,
      projectId: project.id,
      role: 'assistant',
      teamId: team.id,
    },
  })
  return { agentId: agent.id, organizationId: org.id }
}

const cleanup = async (prisma: PrismaClient, organizationId: string) => {
  // The mailbox holds its channel with ON DELETE RESTRICT, so the pair comes
  // apart in order — which is itself the behaviour worth exercising.
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

runDatabaseTest('claiming an address creates the mailbox, its channel and its thread', async () => {
  const prisma = new PrismaClient()
  const seed = await seedOrg(prisma)
  try {
    const localPart = `support-${randomUUID().slice(0, 8)}`
    const mailbox = await createAgentMailbox(prisma, {
      agentId: seed.agentId,
      createdByUserId: randomUUID(),
      defaultDomain: 'Nessie.Works',
      localPart,
      organizationId: seed.organizationId,
    })

    assert.equal(mailbox.address, `${localPart}@nessie.works`, 'domain and local part normalize')

    const channel = await prisma.channel.findUniqueOrThrow({
      select: { dmKey: true, slug: true, systemChannelType: true, type: true, visibility: true },
      where: { id: mailbox.channelId },
    })
    // Each of these is required by `channels_personal_assistant_surface_chk`'s
    // agent_email arm and by `channels_standard_slug_required`; a row that
    // reached the database has satisfied both.
    assert.equal(channel.systemChannelType, 'agent_email')
    assert.equal(channel.type, 'standard')
    assert.equal(channel.dmKey, null)
    assert.ok(channel.slug, 'a standard channel must carry a slug')

    const threads = await prisma.thread.count({ where: { channelId: mailbox.channelId } })
    assert.equal(threads, 1, 'the backing channel opens with its default thread')

    const bindings = await prisma.agentBinding.count({
      where: { agentId: seed.agentId, channelId: mailbox.channelId },
    })
    assert.equal(bindings, 1, 'the agent is bound to its own operations room')
  } finally {
    await cleanup(prisma, seed.organizationId)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a second claim on the same agent is refused in words', async () => {
  const prisma = new PrismaClient()
  const seed = await seedOrg(prisma)
  try {
    await createAgentMailbox(prisma, {
      agentId: seed.agentId,
      createdByUserId: randomUUID(),
      defaultDomain: 'nessie.works',
      localPart: `first-${randomUUID().slice(0, 8)}`,
      organizationId: seed.organizationId,
    })

    await assert.rejects(
      createAgentMailbox(prisma, {
        agentId: seed.agentId,
        createdByUserId: randomUUID(),
        defaultDomain: 'nessie.works',
        localPart: `second-${randomUUID().slice(0, 8)}`,
        organizationId: seed.organizationId,
      }),
      (error: unknown) =>
        error instanceof AgentMailboxError && error.refusal === 'already_has_mailbox',
    )
  } finally {
    await cleanup(prisma, seed.organizationId)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a retired address stays claimed, so it cannot be taken again', async () => {
  const prisma = new PrismaClient()
  const first = await seedOrg(prisma)
  const second = await seedOrg(prisma)
  try {
    const localPart = `shared-${randomUUID().slice(0, 8)}`
    const mailbox = await createAgentMailbox(prisma, {
      agentId: first.agentId,
      createdByUserId: randomUUID(),
      defaultDomain: 'nessie.works',
      localPart,
      organizationId: first.organizationId,
    })
    assert.equal(
      await retireAgentMailbox(prisma, {
        mailboxId: mailbox.id,
        organizationId: first.organizationId,
      }),
      true,
    )

    // The whole point of retirement rather than release: a recycled local part
    // would inherit the previous holder's correspondents.
    await assert.rejects(
      createAgentMailbox(prisma, {
        agentId: second.agentId,
        createdByUserId: randomUUID(),
        defaultDomain: 'nessie.works',
        localPart,
        organizationId: second.organizationId,
      }),
      (error: unknown) => error instanceof AgentMailboxError && error.refusal === 'address_taken',
    )
  } finally {
    await cleanup(prisma, first.organizationId)
    await cleanup(prisma, second.organizationId)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a reserved local part is refused before anything is written', async () => {
  const prisma = new PrismaClient()
  const seed = await seedOrg(prisma)
  try {
    await assert.rejects(
      createAgentMailbox(prisma, {
        agentId: seed.agentId,
        createdByUserId: randomUUID(),
        defaultDomain: 'nessie.works',
        localPart: 'postmaster',
        organizationId: seed.organizationId,
      }),
      (error: unknown) =>
        error instanceof AgentMailboxError && error.refusal === 'invalid_local_part',
    )
    assert.equal(
      await prisma.channel.count({ where: { organizationId: seed.organizationId } }),
      0,
      'a refused claim leaves no half-made channel behind',
    )
  } finally {
    await cleanup(prisma, seed.organizationId)
    await prisma.$disconnect()
  }
})
