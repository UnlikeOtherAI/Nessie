import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import {
  mapMessageRecordWithAttachments,
  messageInclude,
} from '../src/services/message-read-model.js'
import { seed } from './disclosure-read-fixtures.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

runDatabaseTest('a withheld row carries no metadata, reactions, or reply participants', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { name: `disclosure-org-${suffix}` } })
    await prisma.user.deleteMany({ where: { email: { contains: suffix } } })
    await prisma.$disconnect()
  })

  const s = await seed(prisma, suffix)
  const message = await prisma.message.create({
    data: {
      agentId: s.agentId,
      content: 'The acquisition closes on the 14th.',
      // Metadata is derived from the content: the admin renders cards from it,
      // including an actionable Continue button, outside the placeholder branch.
      metadata: { runStop: { continuable: true, runId: 'run-x', stopReason: 'token_limit' } },
      replyParticipantIds: [s.insiderId],
      role: 'assistant',
      threadId: s.threadId,
    },
  })
  await prisma.messageBasisScope.create({
    data: {
      messageId: message.id,
      organizationId: s.organizationId,
      scopeId: s.insiderId,
      scopeType: 'user',
    },
  })
  await prisma.messageReaction.create({
    data: { emoji: '👀', messageId: message.id, userId: s.insiderId },
  })

  const row = await prisma.message.findFirstOrThrow({
    where: { id: message.id },
    include: messageInclude,
  })
  const forOutsider = await mapMessageRecordWithAttachments(prisma, row, {
    channelId: s.channelId,
    organizationId: s.organizationId,
    userId: s.outsiderId,
  })

  assert.equal(forOutsider.restricted, true)
  assert.equal(forOutsider.metadata, undefined, 'metadata leaked through the placeholder')
  assert.deepEqual(forOutsider.reactions, [], 'reactions name who read the restricted content')
  assert.deepEqual(
    forOutsider.replyParticipantIds,
    [],
    'reply participants name who is in the private sub-conversation',
  )
  assert.ok(!JSON.stringify(forOutsider).includes('token_limit'))

  // The entitled reader still gets all of it.
  const forInsider = await mapMessageRecordWithAttachments(prisma, row, {
    channelId: s.channelId,
    organizationId: s.organizationId,
    userId: s.insiderId,
  })
  assert.ok(forInsider.metadata)
  assert.equal(forInsider.reactions.length, 1)
  assert.deepEqual(forInsider.replyParticipantIds, [s.insiderId])
})

runDatabaseTest('the share affordance is offered to a direct reader, not a grant recipient', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { name: `disclosure-org-${suffix}` } })
    await prisma.user.deleteMany({ where: { email: { contains: suffix } } })
    await prisma.$disconnect()
  })

  const s = await seed(prisma, suffix)
  const message = await prisma.message.create({
    data: {
      agentId: s.agentId,
      content: 'Derived from the private channel.',
      role: 'assistant',
      threadId: s.threadId,
    },
  })
  // A team scope, so a standing rule is permitted in principle — that keeps the
  // assertion about *who* may share, not about the kind of material.
  await prisma.messageBasisScope.create({
    data: {
      messageId: message.id,
      organizationId: s.organizationId,
      scopeId: s.teamId,
      scopeType: 'team',
    },
  })
  await prisma.teamMember.create({ data: { teamId: s.teamId, userId: s.insiderId } })

  const row = await prisma.message.findFirstOrThrow({
    where: { id: message.id },
    include: messageInclude,
  })

  const forInsider = await mapMessageRecordWithAttachments(prisma, row, {
    channelId: s.channelId,
    organizationId: s.organizationId,
    userId: s.insiderId,
  })
  assert.equal(forInsider.restrictedSources, true, 'a direct reader is the one who can share')
  assert.equal(forInsider.canShareStanding, true)

  // Now let the outsider in by grant rather than by entitlement.
  await prisma.disclosureGrant.create({
    data: {
      audienceId: s.outsiderId,
      audienceKind: 'user',
      grantedByUserId: s.insiderId,
      messageId: message.id,
      organizationId: s.organizationId,
    },
  })
  const forGrantee = await mapMessageRecordWithAttachments(prisma, row, {
    channelId: s.channelId,
    organizationId: s.organizationId,
    userId: s.outsiderId,
  })

  assert.notEqual(forGrantee.restricted, true, 'the grant should make it readable')
  assert.equal(forGrantee.content, 'Derived from the private channel.')
  assert.equal(
    forGrantee.restrictedSources,
    undefined,
    'a grant recipient must not be offered a share the server then refuses',
  )
})
