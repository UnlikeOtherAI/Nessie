import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'

import { runChannelFindTool, runChannelListTool } from '../../src/run/pa-tools/channels.js'
import type { BuiltinToolRuntimeContext } from '../../src/run/tool-types.js'
import { runDatabaseTest } from './support.js'

// `channel_find` narrows by a label/slug `OR`. The visibility predicate is an
// `OR` too, so spreading one object and then writing the other key replaced the
// visibility rule outright and the tool named private channels the person had
// never joined. These cases run against Postgres because the defect is the
// shape of the where clause, which a findMany stub cannot evaluate.

type Seed = {
  agentId: string
  memberChannelId: string
  organizationId: string
  outsiderChannelId: string
  projectId: string
  publicChannelId: string
  userIds: string[]
  viewerId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const short = suffix.slice(0, 8)
  const [viewer, other] = await Promise.all([
    prisma.user.create({ data: { displayName: 'Viewer', email: `find-viewer-${suffix}@example.test` } }),
    prisma.user.create({ data: { displayName: 'Other', email: `find-other-${suffix}@example.test` } }),
  ])
  const organization = await prisma.organization.create({ data: { name: `channel-find-${suffix}` } })
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: organization.id, role: 'member', userId: viewer.id },
      { organizationId: organization.id, role: 'member', userId: other.id },
    ],
  })
  const project = await prisma.project.create({
    data: { name: `find-project-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({ data: { name: `find-team-${suffix}`, projectId: project.id } })
  const channel = (label: string, visibility: 'public' | 'private') =>
    prisma.channel.create({
      data: {
        label: `${label}-${short}`,
        organizationId: organization.id,
        projectId: project.id,
        slug: `${label}-${short}`,
        teamId: team.id,
        type: 'standard',
        visibility,
      },
    })
  const publicChannel = await channel('findme-public', 'public')
  const memberChannel = await channel('findme-member', 'private')
  const outsiderChannel = await channel('findme-secret', 'private')
  await prisma.channelMember.createMany({
    data: [
      { channelId: memberChannel.id, userId: viewer.id },
      { channelId: outsiderChannel.id, userId: other.id },
    ],
  })
  const agent = await prisma.agent.create({
    data: {
      agentKind: 'personal_assistant',
      delegationMode: 'act_as_requesting_user',
      name: `find-agent-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      surfacePolicy: 'dm_only',
      systemManaged: true,
      teamId: team.id,
    },
  })
  return {
    agentId: agent.id,
    memberChannelId: memberChannel.id,
    organizationId: organization.id,
    outsiderChannelId: outsiderChannel.id,
    projectId: project.id,
    publicChannelId: publicChannel.id,
    userIds: [viewer.id, other.id],
    viewerId: viewer.id,
  }
}

const contextFor = (prisma: PrismaClient, s: Seed): BuiltinToolRuntimeContext => ({
  actorContext: {
    actionContext: { effectiveUserId: s.viewerId, requestId: randomUUID() },
    actor: { actorId: s.viewerId, actorType: 'user', roles: ['member'] },
    tenant: { organizationId: s.organizationId, projectId: s.projectId },
  },
  agentId: s.agentId,
  agentKind: 'personal_assistant',
  channel: { id: s.publicChannelId, organizationId: s.organizationId, systemChannelType: null },
  ledgerIdentity: null,
  prisma,
  realtimeTransport: {} as BuiltinToolRuntimeContext['realtimeTransport'],
  run: { id: randomUUID(), messageId: randomUUID(), threadId: randomUUID() },
  toolCallId: randomUUID(),
})

runDatabaseTest('channel_find never names a private channel the person has not joined', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { id: s.organizationId } })
    await prisma.user.deleteMany({ where: { id: { in: s.userIds } } })
    await prisma.$disconnect()
  })
  const context = contextFor(prisma, s)

  const found = await runChannelFindTool(context, { query: 'findme' })
  assert.match(found.outputPreview, new RegExp(s.publicChannelId))
  assert.match(found.outputPreview, new RegExp(s.memberChannelId))
  assert.doesNotMatch(
    found.outputPreview,
    new RegExp(s.outsiderChannelId),
    'a private channel the person never joined was returned by label match',
  )
  assert.doesNotMatch(found.outputPreview, /findme-secret/)

  // The directory listing shares the predicate and must agree with the finder.
  const listed = await runChannelListTool(context, {})
  assert.doesNotMatch(listed.outputPreview, new RegExp(s.outsiderChannelId))
})
