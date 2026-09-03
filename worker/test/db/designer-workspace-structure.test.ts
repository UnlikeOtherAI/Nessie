import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import {
  AGENT_DESIGNER_BLUEPRINT,
  createProjectForUser,
  ensureGlobalAgentBootstrap,
} from '@nessie/workspace-admin'

import { runChannelCreateTool } from '../../src/run/pa-tools/provisioning.js'
import {
  runProjectCreateTool,
  runProjectListTool,
  runTeamCreateTool,
} from '../../src/run/pa-tools/workspace-structure.js'
import type { BuiltinToolRuntimeContext } from '../../src/run/tool-types.js'
import { runDatabaseTest } from './support.js'

/**
 * The Agent Designer standing up a place to work: a project, a team in it, and
 * a channel in that team — against real rows, in its own bootstrapped home DM.
 *
 * What a fake cannot prove and this does: the channel really lands in the
 * project (the hierarchy is three tables deep), each write leaves exactly ONE
 * membership row (the person who asked), a channel the model did not classify
 * is NOT publicly discoverable, and a non-owner is refused in words with
 * nothing written. It also asserts the mirroring claim directly: the row the
 * tool writes is the row `POST /api/projects`'s own shared function writes.
 *
 * Cleanup is scoped to this suite's own organisations.
 */

type Seed = {
  agentId: string
  homeChannelId: string
  memberId: string
  organizationId: string
  otherOrganizationId: string
  otherProjectId: string
  ownerId: string
  projectId: string
  teamId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const owner = await prisma.user.create({
    data: { displayName: 'Owner', email: `designer-owner-${suffix}@example.test` },
  })
  const member = await prisma.user.create({
    data: { displayName: 'Member', email: `designer-member-${suffix}@example.test` },
  })
  const organization = await prisma.organization.create({
    data: { name: `designer-structure-${suffix}` },
  })
  const otherOrganization = await prisma.organization.create({
    data: { name: `designer-foreign-${suffix}` },
  })
  const otherProject = await prisma.project.create({
    data: { name: 'Foreign', organizationId: otherOrganization.id },
  })
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: organization.id, role: 'owner', userId: owner.id },
      { organizationId: organization.id, role: 'member', userId: member.id },
    ],
  })
  const project = await prisma.project.create({
    data: { name: `designer-home-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({
    data: { name: `designer-home-team-${suffix}`, projectId: project.id },
  })

  // The real home DM: `system_agent`, the `gagent:` dmKey, the blueprint's own
  // agent row — the surface every identity-delegated tool call arrives on.
  const bootstrap = await ensureGlobalAgentBootstrap(prisma, {
    blueprint: AGENT_DESIGNER_BLUEPRINT,
    organizationId: organization.id,
    teamId: team.id,
    userId: owner.id,
  })

  return {
    agentId: bootstrap.agentId,
    homeChannelId: bootstrap.channelId,
    memberId: member.id,
    organizationId: organization.id,
    otherOrganizationId: otherOrganization.id,
    otherProjectId: otherProject.id,
    ownerId: owner.id,
    projectId: project.id,
    teamId: team.id,
  }
}

const cleanup = async (prisma: PrismaClient, workspace: Seed): Promise<void> => {
  await prisma.organization.deleteMany({
    where: { id: { in: [workspace.organizationId, workspace.otherOrganizationId] } },
  })
  await prisma.user.deleteMany({
    where: { id: { in: [workspace.memberId, workspace.ownerId] } },
  })
}

const buildContext = (
  prisma: PrismaClient,
  workspace: Seed,
  actingUserId: string,
): BuiltinToolRuntimeContext =>
  ({
    actorContext: {
      actionContext: {
        // The home DM stamps `effectiveUserId` for its sole member; that is what
        // makes the tools act as the person, and what `resolveActingMember`
        // re-reads the live role for.
        effectiveUserId: actingUserId,
        requestId: `designer-structure-${randomUUID()}`,
        teamId: workspace.teamId,
      },
      actor: { actorId: actingUserId, actorType: 'user', roles: ['member'] },
      tenant: {
        organizationId: workspace.organizationId,
        projectId: workspace.projectId,
        teamId: workspace.teamId,
      },
    },
    agentId: workspace.agentId,
    agentKind: 'shared',
    channel: {
      id: workspace.homeChannelId,
      organizationId: workspace.organizationId,
      systemChannelType: 'system_agent',
    },
    ledgerIdentity: null,
    prisma,
    realtimeTransport: {} as BuiltinToolRuntimeContext['realtimeTransport'],
    run: {
      id: randomUUID(),
      interactive: true,
      messageId: randomUUID(),
      threadId: randomUUID(),
    },
    toolCallId: randomUUID(),
  }) as unknown as BuiltinToolRuntimeContext

const idFrom = (output: string, key: string): string => {
  const match = new RegExp(`${key}=([0-9a-f-]{36})`).exec(output)
  assert.ok(match, `expected a ${key} in:\n${output}`)
  return match[1] as string
}

const refusal = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected the tool to refuse')
}

runDatabaseTest('the Designer stands up a project, a team and a channel in it', async (t) => {
  const prisma = new PrismaClient()
  const workspace = await seed(prisma)
  t.after(() => cleanup(prisma, workspace).then(() => prisma.$disconnect()))
  const context = buildContext(prisma, workspace, workspace.ownerId)

  const projectResult = await runProjectCreateTool(context, { name: 'Marketing' })
  const projectId = idFrom(projectResult.outputPreview, 'projectId')

  const teamResult = await runTeamCreateTool(context, { name: 'Campaigns', projectId })
  const teamId = idFrom(teamResult.outputPreview, 'teamId')

  // Deliberately no `visibility`: what the model omits must not publish a room
  // to the whole organisation.
  const channelResult = await runChannelCreateTool(context, {
    label: 'Launch plan',
    teamId,
  })
  const channelId = idFrom(channelResult.outputPreview, 'channelId')

  const channel = await prisma.channel.findUniqueOrThrow({
    where: { id: channelId },
    select: { organizationId: true, projectId: true, teamId: true, visibility: true },
  })
  assert.equal(channel.projectId, projectId, 'the channel belongs to the new project')
  assert.equal(channel.teamId, teamId)
  assert.equal(channel.organizationId, workspace.organizationId)
  assert.equal(channel.visibility, 'private')

  // One member each — the person who asked, and nobody else.
  assert.deepEqual(
    await prisma.projectMember.findMany({
      where: { projectId },
      select: { role: true, userId: true },
    }),
    [{ role: 'owner', userId: workspace.ownerId }],
  )
  assert.deepEqual(
    await prisma.teamMember.findMany({
      where: { teamId },
      select: { role: true, userId: true },
    }),
    [{ role: 'owner', userId: workspace.ownerId }],
  )
  assert.deepEqual(
    await prisma.channelMember.findMany({
      where: { channelId },
      select: { userId: true },
    }),
    [{ userId: workspace.ownerId }],
  )

  // The resolving read finds both, so a NAME becomes the id the writes take.
  const listed = await runProjectListTool(context, { query: 'campaigns' })
  assert.match(listed.outputPreview, new RegExp(`projectId=${projectId}`))
  assert.match(listed.outputPreview, new RegExp(`teamId=${teamId}`))

  // The mirroring claim, asserted: the same input through the function the
  // route calls produces the same row shape.
  const viaRoute = await createProjectForUser(prisma, {
    name: 'Marketing (clicked)',
    organizationId: workspace.organizationId,
    userId: workspace.ownerId,
  })
  const [viaTool, clicked] = await Promise.all([
    prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: {
        channelRoot: true,
        organizationId: true,
        _count: { select: { boardColumns: true, members: true } },
      },
    }),
    prisma.project.findUniqueOrThrow({
      where: { id: viaRoute.id },
      select: {
        channelRoot: true,
        organizationId: true,
        _count: { select: { boardColumns: true, members: true } },
      },
    }),
  ])
  assert.deepEqual(viaTool, clicked)
})

runDatabaseTest('a non-owner is refused in words and writes nothing', async (t) => {
  const prisma = new PrismaClient()
  const workspace = await seed(prisma)
  t.after(() => cleanup(prisma, workspace).then(() => prisma.$disconnect()))
  const context = buildContext(prisma, workspace, workspace.memberId)

  const projectsBefore = await prisma.project.count({
    where: { organizationId: workspace.organizationId },
  })
  const teamsBefore = await prisma.team.count({
    where: { project: { organizationId: workspace.organizationId } },
  })

  const projectRefusal = await refusal(
    runProjectCreateTool(context, { name: 'Marketing' }),
  )
  assert.match(projectRefusal, /Only an organisation owner can create a project/)
  assert.match(projectRefusal, /Ask an owner/)

  const teamRefusal = await refusal(
    runTeamCreateTool(context, { name: 'Campaigns', projectId: workspace.projectId }),
  )
  assert.match(teamRefusal, /Only an organisation owner can create a team/)

  assert.equal(
    await prisma.project.count({ where: { organizationId: workspace.organizationId } }),
    projectsBefore,
  )
  assert.equal(
    await prisma.team.count({
      where: { project: { organizationId: workspace.organizationId } },
    }),
    teamsBefore,
  )

  // `channel_create` is deliberately NOT owner-gated: `POST /api/channels`
  // carries only `requireActorContext`, and a tool mirrors its route exactly —
  // no weaker, no stronger.
  const channelResult = await runChannelCreateTool(context, {
    label: 'Member room',
    teamId: workspace.teamId,
  })
  const channelId = idFrom(channelResult.outputPreview, 'channelId')
  const channel = await prisma.channel.findUniqueOrThrow({
    where: { id: channelId },
    select: { visibility: true },
  })
  assert.equal(channel.visibility, 'private')
})

runDatabaseTest('team_create refuses a cross-organisation projectId', async (t) => {
  const prisma = new PrismaClient()
  const workspace = await seed(prisma)
  t.after(() => cleanup(prisma, workspace).then(() => prisma.$disconnect()))
  const context = buildContext(prisma, workspace, workspace.ownerId)

  const message = await refusal(
    runTeamCreateTool(context, {
      name: 'Campaigns',
      projectId: workspace.otherProjectId,
    }),
  )
  assert.match(message, /Project not found/)
  assert.equal(
    await prisma.team.count({ where: { projectId: workspace.otherProjectId } }),
    0,
  )
})

runDatabaseTest('project_list is scoped to the caller and their organisation', async (t) => {
  const prisma = new PrismaClient()
  const workspace = await seed(prisma)
  t.after(() => cleanup(prisma, workspace).then(() => prisma.$disconnect()))

  const ownerContext = buildContext(prisma, workspace, workspace.ownerId)
  const ownerProject = idFrom(
    (await runProjectCreateTool(ownerContext, { name: 'Owner only' })).outputPreview,
    'projectId',
  )

  const memberContext = buildContext(prisma, workspace, workspace.memberId)
  const asMember = await runProjectListTool(memberContext, {})
  assert.ok(
    !asMember.outputPreview.includes(ownerProject),
    'a member never sees a project they do not belong to',
  )

  const asOwner = await runProjectListTool(ownerContext, {})
  assert.match(asOwner.outputPreview, new RegExp(`projectId=${ownerProject}`))
  assert.ok(
    !asOwner.outputPreview.includes(workspace.otherProjectId),
    'never another organisation',
  )
})
