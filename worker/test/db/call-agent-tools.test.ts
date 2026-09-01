import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { Prisma, PrismaClient } from '@prisma/client'

import { runMeetingLinkCreateTool } from '../../src/run/pa-tools/calls.js'
import { executeBuiltinTool } from '../../src/run/tools.js'
import type { BuiltinToolRuntimeContext } from '../../src/run/tool-types.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  agentId: string
  callerId: string
  inviteeId: string
  homeChannelId: string
  homeOrganizationId: string
  homeProjectId: string
  homeTeamId: string
  targetChannelId: string
  targetOrganizationId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const caller = await prisma.user.create({
    data: { displayName: 'Caller', email: `call-agent-caller-${suffix}@example.test` },
  })
  const invitee = await prisma.user.create({
    data: { displayName: 'Invitee', email: `call-agent-invitee-${suffix}@example.test` },
  })
  const [homeOrganization, targetOrganization] = await Promise.all([
    prisma.organization.create({ data: { name: `call-agent-home-${suffix}` } }),
    prisma.organization.create({ data: { name: `call-agent-target-${suffix}` } }),
  ])
  const [homeProject, targetProject] = await Promise.all([
    prisma.project.create({ data: { name: 'home project', organizationId: homeOrganization.id } }),
    prisma.project.create({ data: { name: 'target project', organizationId: targetOrganization.id } }),
  ])
  const [homeTeam, targetTeam] = await Promise.all([
    prisma.team.create({
      data: { callProvider: 'jitsi', name: 'home team', projectId: homeProject.id },
    }),
    prisma.team.create({
      data: { callProvider: 'google_meet', name: 'target team', projectId: targetProject.id },
    }),
  ])
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: homeOrganization.id, userId: caller.id },
      { organizationId: targetOrganization.id, userId: caller.id },
      { organizationId: targetOrganization.id, userId: invitee.id },
    ],
  })
  const [homeChannel, targetChannel] = await Promise.all([
    prisma.channel.create({
      data: {
        label: 'home calls',
        slug: `home-calls-${suffix}`,
        organizationId: homeOrganization.id,
        projectId: homeProject.id,
        teamId: homeTeam.id,
        members: { create: { userId: caller.id } },
      },
    }),
    prisma.channel.create({
      data: {
        label: 'target calls',
        slug: `target-calls-${suffix}`,
        organizationId: targetOrganization.id,
        projectId: targetProject.id,
        teamId: targetTeam.id,
        members: { create: [{ userId: caller.id }, { userId: invitee.id }] },
      },
    }),
  ])
  const agent = await prisma.agent.create({
    data: {
      agentKind: 'personal_assistant',
      delegationMode: 'act_as_requesting_user',
      name: `Call PA ${suffix}`,
      surfacePolicy: 'dm_only',
      systemManaged: true,
    },
  })

  return {
    agentId: agent.id,
    callerId: caller.id,
    homeChannelId: homeChannel.id,
    homeOrganizationId: homeOrganization.id,
    homeProjectId: homeProject.id,
    homeTeamId: homeTeam.id,
    inviteeId: invitee.id,
    targetChannelId: targetChannel.id,
    targetOrganizationId: targetOrganization.id,
  }
}

const cleanup = async (prisma: PrismaClient, workspace: Seed): Promise<void> => {
  await prisma.$executeRaw(Prisma.sql`
    DELETE FROM queue_jobs
    WHERE payload->>'callId' IN (
      SELECT id::text FROM calls WHERE channel_id = ${workspace.targetChannelId}::uuid
    )
  `)
  await prisma.organization.deleteMany({
    where: { id: { in: [workspace.homeOrganizationId, workspace.targetOrganizationId] } },
  })
  await prisma.agent.delete({ where: { id: workspace.agentId } })
  await prisma.user.deleteMany({ where: { id: { in: [workspace.callerId, workspace.inviteeId] } } })
}

const contextFor = (
  prisma: PrismaClient,
  workspace: Seed,
  unattended = false,
): { context: BuiltinToolRuntimeContext; publications: string[] } => {
  const actor = unattended
    ? { actorId: workspace.agentId, actorType: 'agent' as const, roles: ['system'] }
    : { actorId: workspace.callerId, actorType: 'user' as const, roles: ['member'] }
  const publications: string[] = []
  return {
    context: {
      agentId: workspace.agentId,
      agentKind: 'personal_assistant',
      actorContext: {
        actionContext: { requestId: `call-agent-tools-${randomUUID()}`, teamId: workspace.homeTeamId },
        actor,
        tenant: {
          organizationId: workspace.homeOrganizationId,
          projectId: workspace.homeProjectId,
          teamId: workspace.homeTeamId,
        },
      },
      channel: { id: workspace.homeChannelId, organizationId: workspace.homeOrganizationId },
      ledgerIdentity: null,
      prisma,
      realtimeTransport: {
        publishWs: async (_scopes: unknown, event: { event: string }) => {
          publications.push(event.event)
        },
      } as BuiltinToolRuntimeContext['realtimeTransport'],
      run: { id: randomUUID(), messageId: randomUUID(), threadId: randomUUID() },
      toolCallId: randomUUID(),
      },
    publications,
  } as { context: BuiltinToolRuntimeContext; publications: string[] }
}

runDatabaseTest('PA call tools use the target channel tenant, honour a provider override, and attribute the call to the PA', async (t) => {
  const prisma = new PrismaClient()
  const workspace = await seed(prisma)
  t.after(async () => {
    await cleanup(prisma, workspace)
    await prisma.$disconnect()
  })

  const { context, publications } = contextFor(prisma, workspace)
  assert.notEqual(workspace.homeOrganizationId, workspace.targetOrganizationId)
  const link = await runMeetingLinkCreateTool(context, { teamId: workspace.homeTeamId })
  const linkOutput = JSON.parse(link.outputPreview) as { meetingUri: string; provider: string }
  assert.equal(linkOutput.provider, 'jitsi')
  assert.match(linkOutput.meetingUri, /^https:\/\/meet\.jit\.si\/nessie-/)

  const started = await executeBuiltinTool('call_start', {
    channelId: workspace.targetChannelId,
    provider: 'jitsi',
  }, context)

  assert.equal(started.success, true)
  const output = JSON.parse(started.output) as {
    callId: string
    meetingUri: string
    provider: string
    status: string
  }
  assert.equal(output.provider, 'jitsi')
  assert.equal(output.status, 'ringing')
  assert.match(output.meetingUri, /^https:\/\/meet\.jit\.si\/nessie-/)

  const call = await prisma.call.findUniqueOrThrow({ where: { id: output.callId } })
  assert.equal(call.channelId, workspace.targetChannelId)
  assert.equal(call.createdViaAgentId, workspace.agentId)
  assert.equal(call.provider, 'jitsi')
  assert.equal(await prisma.callInvite.count({ where: { callId: call.id, state: 'ringing' } }), 1)
  assert.deepEqual(publications.sort(), ['call.incoming', 'call.updated'])
})

runDatabaseTest('call tools refuse an unattended PA run before minting a link', async (t) => {
  const prisma = new PrismaClient()
  const workspace = await seed(prisma)
  t.after(async () => {
    await cleanup(prisma, workspace)
    await prisma.$disconnect()
  })

  await assert.rejects(
    runMeetingLinkCreateTool(contextFor(prisma, workspace, true).context, { teamId: workspace.homeTeamId }),
    /only create or start a call when a person asks me directly/,
  )
})
