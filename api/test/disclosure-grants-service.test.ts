import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import {
  DisclosureGrantError,
  grantMessageDisclosure,
  grantScopeDisclosure,
} from '../src/services/disclosure-grants.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

// F1-4: the audience-validation and upsert-construction workflow moved out of
// `routes/disclosure-grants.ts` and into these two service functions. These
// tests pin the business rule that was previously only exercisable by booting
// Fastify: a share is bounded by the granter's own reach, never merely by
// "any uuid the client sent" or "any member of the organisation".

type Seed = {
  organizationId: string
  teamId: string
  channelId: string
  privateChannelId: string
  threadId: string
  agentId: string
  granterId: string
  memberId: string
}

// One organisation, a public channel the granter is in, a private channel the
// granter is *not* in, and a plain org member who never joined either.
const seed = async (prisma: PrismaClient, suffix: string): Promise<Seed> => {
  const organization = await prisma.organization.create({
    data: { name: `disclosure-grant-org-${suffix}` },
  })
  const project = await prisma.project.create({
    data: { name: `p-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({
    data: { name: `t-${suffix}`, projectId: project.id },
  })
  const channel = await prisma.channel.create({
    data: {
      label: `c-${suffix}`,
      slug: `c-${suffix.slice(0, 8)}`,
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
      type: 'standard',
      visibility: 'public',
    },
  })
  const privateChannel = await prisma.channel.create({
    data: {
      label: `pc-${suffix}`,
      slug: `pc-${suffix.slice(0, 8)}`,
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
      type: 'standard',
      visibility: 'private',
    },
  })
  const thread = await prisma.thread.create({
    data: { channelId: channel.id, title: 'main' },
  })
  const agent = await prisma.agent.create({
    data: { name: `a-${suffix}`, organizationId: organization.id, projectId: project.id, teamId: team.id },
  })

  const granter = await prisma.user.create({
    data: { email: `granter-${suffix}@example.com`, displayName: 'granter' },
  })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, userId: granter.id, role: 'member' },
  })
  await prisma.channelMember.create({ data: { channelId: channel.id, userId: granter.id } })

  const member = await prisma.user.create({
    data: { email: `member-${suffix}@example.com`, displayName: 'member' },
  })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, userId: member.id, role: 'member' },
  })

  return {
    agentId: agent.id,
    channelId: channel.id,
    granterId: granter.id,
    memberId: member.id,
    organizationId: organization.id,
    privateChannelId: privateChannel.id,
    teamId: team.id,
    threadId: thread.id,
  }
}

// A message whose basis is the granter's own `user` scope: any org member
// trivially satisfies their own user scope, so this makes the granter
// entitled without needing a private-channel setup, and it caps the duration
// menu to none — exercising both `canGrantDisclosure` and
// `allowedDurationsForBasis` with the minimum fixture.
const createRestrictedMessage = async (
  prisma: PrismaClient,
  s: Seed,
  scope: { scopeType: string; scopeId: string } = { scopeType: 'user', scopeId: s.granterId },
) => {
  const message = await prisma.message.create({
    data: { agentId: s.agentId, content: 'restricted', role: 'assistant', threadId: s.threadId },
  })
  await prisma.messageBasisScope.create({
    data: {
      messageId: message.id,
      organizationId: s.organizationId,
      scopeId: scope.scopeId,
      scopeType: scope.scopeType,
    },
  })
  return message
}

const cleanup = (prisma: PrismaClient, suffix: string) => async () => {
  await prisma.organization.deleteMany({ where: { name: `disclosure-grant-org-${suffix}` } })
  await prisma.user.deleteMany({ where: { email: { contains: suffix } } })
  await prisma.$disconnect()
}

runDatabaseTest('grantMessageDisclosure refuses a user audience the granter cannot vouch for', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  t.after(cleanup(prisma, suffix))

  const s = await seed(prisma, suffix)
  const message = await createRestrictedMessage(prisma, s)

  await assert.rejects(
    () => grantMessageDisclosure(prisma, {
      audienceId: randomUUID(),
      audienceKind: 'user',
      messageId: message.id,
      organizationId: s.organizationId,
      userId: s.granterId,
    }),
    (error: unknown) => {
      assert.ok(error instanceof DisclosureGrantError)
      assert.equal(error.code, 'DISCLOSURE_AUDIENCE_NOT_FOUND')
      assert.equal(error.status, 422)
      return true
    },
  )
})

runDatabaseTest('grantMessageDisclosure refuses a channel the granter is not in', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  t.after(cleanup(prisma, suffix))

  const s = await seed(prisma, suffix)
  const message = await createRestrictedMessage(prisma, s)

  // The channel exists — it is simply not the granter's own reach, which is
  // the property this check has to hold, not merely "the id resolves".
  await assert.rejects(
    () => grantMessageDisclosure(prisma, {
      audienceId: s.privateChannelId,
      audienceKind: 'channel',
      messageId: message.id,
      organizationId: s.organizationId,
      userId: s.granterId,
    }),
    (error: unknown) => {
      assert.ok(error instanceof DisclosureGrantError)
      assert.equal(error.code, 'DISCLOSURE_AUDIENCE_NOT_FOUND')
      return true
    },
  )
})

runDatabaseTest('grantMessageDisclosure accepts an audience the granter can actually reach', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  t.after(cleanup(prisma, suffix))

  const s = await seed(prisma, suffix)
  const message = await createRestrictedMessage(prisma, s)

  const grant = await grantMessageDisclosure(prisma, {
    audienceId: s.memberId,
    audienceKind: 'user',
    messageId: message.id,
    organizationId: s.organizationId,
    userId: s.granterId,
  })
  assert.ok(grant.id)

  const row = await prisma.disclosureGrant.findUnique({ where: { id: grant.id } })
  assert.equal(row?.audienceId, s.memberId)
  assert.equal(row?.audienceKind, 'user')
})

runDatabaseTest('grantScopeDisclosure caps the standing-rule duration for private material', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  t.after(cleanup(prisma, suffix))

  const s = await seed(prisma, suffix)
  // scopeType 'user' → allowedDurationsForBasis returns none: a standing rule
  // over private material is consent to future, unseen content.
  const message = await createRestrictedMessage(prisma, s)

  await assert.rejects(
    () => grantScopeDisclosure(prisma, {
      duration: '30d',
      messageId: message.id,
      organizationId: s.organizationId,
      userId: s.granterId,
    }),
    (error: unknown) => {
      assert.ok(error instanceof DisclosureGrantError)
      assert.equal(error.code, 'DISCLOSURE_DURATION_NOT_ALLOWED')
      assert.equal(error.status, 422)
      return true
    },
  )
})

runDatabaseTest('grantScopeDisclosure refuses a scope grant for a message with no agent author', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  t.after(cleanup(prisma, suffix))

  const s = await seed(prisma, suffix)
  // A team scope keeps the duration menu open, isolating the agent check.
  await prisma.teamMember.create({ data: { teamId: s.teamId, userId: s.granterId } })
  const message = await prisma.message.create({
    data: { content: 'no agent', role: 'assistant', threadId: s.threadId },
  })
  await prisma.messageBasisScope.create({
    data: {
      messageId: message.id,
      organizationId: s.organizationId,
      scopeId: s.teamId,
      scopeType: 'team',
    },
  })

  await assert.rejects(
    () => grantScopeDisclosure(prisma, {
      messageId: message.id,
      organizationId: s.organizationId,
      userId: s.granterId,
    }),
    (error: unknown) => {
      assert.ok(error instanceof DisclosureGrantError)
      assert.equal(error.code, 'DISCLOSURE_SCOPE_GRANT_NEEDS_AGENT')
      return true
    },
  )
})
