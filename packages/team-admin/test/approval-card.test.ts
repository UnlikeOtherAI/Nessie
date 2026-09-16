import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import {
  personalAssistantDmKey,
  postApprovalCards,
  resolveApprovalCardTargets,
  updateApprovalCardsStatus,
} from '../src/approval-card.js'

/**
 * Where an approval is answerable, now that a list of them no longer exists.
 *
 * The rule has two halves and both are load-bearing. An approval belongs in the
 * conversation it came from — which is also the requester's conversation for a
 * delegated run, because a sub-agent run is created on its parent's thread. And
 * an approver who cannot see that conversation gets the same card in their own
 * Personal Assistant conversation, because an owner-gated proposal is raised in
 * whatever channel the agent was working in and an organisation owner is not
 * automatically a member of it. Without the second half the request would have
 * nowhere to be answered and would expire unseen.
 */

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  insiderId: string
  organizationId: string
  originChannelId: string
  originThreadId: string
  outsiderId: string
  outsiderAssistantThreadId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const organization = await prisma.organization.create({
    data: { name: `approval-card-${suffix}` },
  })
  const project = await prisma.project.create({
    data: { name: `approval-card-p-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({
    data: { name: `approval-card-t-${suffix}`, projectId: project.id },
  })
  const insider = await prisma.user.create({
    data: { displayName: 'In the room', email: `card-in-${suffix}@example.test` },
  })
  const outsider = await prisma.user.create({
    data: { displayName: 'Owner elsewhere', email: `card-out-${suffix}@example.test` },
  })

  // A private channel the outsider is not a member of — the shape an
  // owner-gated proposal is actually raised in.
  const origin = await prisma.channel.create({
    data: {
      label: 'work',
      members: { create: [{ userId: insider.id }] },
      organizationId: organization.id,
      projectId: project.id,
      slug: `work-${suffix.slice(0, 8)}`,
      teamId: team.id,
      type: 'standard',
      visibility: 'private',
    },
  })
  const originThread = await prisma.thread.create({
    data: { channelId: origin.id, title: 'General' },
  })
  const assistant = await prisma.channel.create({
    data: {
      dmKey: personalAssistantDmKey({ organizationId: organization.id, userId: outsider.id }),
      label: 'Personal Assistant',
      members: { create: [{ userId: outsider.id }] },
      organizationId: organization.id,
      projectId: project.id,
      systemChannelType: 'personal_assistant',
      teamId: team.id,
      type: 'dm',
      visibility: 'private',
    },
  })
  const assistantThread = await prisma.thread.create({
    data: { channelId: assistant.id, title: 'General' },
  })

  return {
    insiderId: insider.id,
    organizationId: organization.id,
    originChannelId: origin.id,
    originThreadId: originThread.id,
    outsiderAssistantThreadId: assistantThread.id,
    outsiderId: outsider.id,
  }
}

runDatabaseTest('an approver in the room answers on the card already in front of them', async () => {
  const prisma = new PrismaClient()
  try {
    const context = await seed(prisma)
    const targets = await resolveApprovalCardTargets(prisma, {
      approverUserIds: [context.insiderId],
      organizationId: context.organizationId,
      originChannelId: context.originChannelId,
      originThreadId: context.originThreadId,
    })

    assert.equal(targets.length, 1)
    assert.equal(targets[0]?.placement, 'origin')
    assert.equal(targets[0]?.threadId, context.originThreadId)
  } finally {
    await prisma.$disconnect()
  }
})

runDatabaseTest('an approver who cannot see the room gets the card in their own assistant', async () => {
  const prisma = new PrismaClient()
  try {
    const context = await seed(prisma)
    const targets = await resolveApprovalCardTargets(prisma, {
      approverUserIds: [context.outsiderId],
      organizationId: context.organizationId,
      originChannelId: context.originChannelId,
      originThreadId: context.originThreadId,
    })

    assert.deepEqual(
      targets.map((target) => [target.placement, target.threadId]),
      [
        ['origin', context.originThreadId],
        ['assistant', context.outsiderAssistantThreadId],
      ],
    )
  } finally {
    await prisma.$disconnect()
  }
})

runDatabaseTest('a request with no channel of its own lives only in the approver\'s assistant', async () => {
  const prisma = new PrismaClient()
  try {
    const context = await seed(prisma)
    const targets = await resolveApprovalCardTargets(prisma, {
      approverUserIds: [context.outsiderId],
      organizationId: context.organizationId,
      originChannelId: null,
      originThreadId: null,
    })

    assert.deepEqual(
      targets.map((target) => [target.placement, target.threadId]),
      [['assistant', context.outsiderAssistantThreadId]],
    )
  } finally {
    await prisma.$disconnect()
  }
})

runDatabaseTest('answering stamps every copy, not the one in the room', async () => {
  const prisma = new PrismaClient()
  try {
    const context = await seed(prisma)
    const approvalId = randomUUID()
    const targets = await resolveApprovalCardTargets(prisma, {
      approverUserIds: [context.outsiderId],
      organizationId: context.organizationId,
      originChannelId: context.originChannelId,
      originThreadId: context.originThreadId,
    })
    const written = await postApprovalCards(prisma, {
      agentId: null,
      content: 'A to-do template is waiting for approval.',
      gate: {
        action: 'agent.todo_template.publish',
        approvalId,
        status: 'pending',
      },
      targets,
    })
    assert.equal(written.length, 2)

    assert.equal(await updateApprovalCardsStatus(prisma, { approvalId, status: 'approved' }), 2)

    const cards = await prisma.message.findMany({
      select: { metadata: true },
      where: { id: { in: written.map((card) => card.messageId) } },
    })
    assert.equal(cards.length, 2)
    for (const card of cards) {
      const gate = (card.metadata as Record<string, Record<string, unknown>>)['approvalGate']
      // A card still offering Approve after somebody else answered is a lie
      // about what the button will do.
      assert.equal(gate?.['status'], 'approved')
      assert.equal(gate?.['action'], 'agent.todo_template.publish')
    }
  } finally {
    await prisma.$disconnect()
  }
})
