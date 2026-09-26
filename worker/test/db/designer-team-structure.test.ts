import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import {
  AGENT_DESIGNER_BLUEPRINT,
  createProjectForUser,
  ensureGlobalAgentBootstrap,
} from '@nessie/team-admin'

import { runAgentUpdateTool } from '../../src/run/pa-tools/agent-config.js'
import { runAgentTriggerListTool, runAgentTriggerUpdateTool } from '../../src/run/pa-tools/agent-lifecycle.js'
import {
  runAgentBindChannelTool,
  runAgentCreateTool,
  runAgentListTool,
  runAgentTriggerCreateTool,
  runChannelCreateTool,
} from '../../src/run/pa-tools/provisioning.js'
import {
  runProjectCreateTool,
  runProjectListTool,
  runTeamCreateTool,
} from '../../src/run/pa-tools/team-structure.js'
import type { BuiltinToolRuntimeContext } from '../../src/run/tool-types.js'
import { runDatabaseTest } from './support.js'

/**
 * The Agent Designer standing up a place to work: a project and a channel in
 * its existing team — against real rows, in its own bootstrapped home DM.
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
  // `canPlaceChannelInTeam` (packages/team-admin/src/channel-create.ts) now
  // requires a `TeamMember`/`ProjectMember` row (or org owner/admin) before a
  // channel can land in a team — `member` needs standing here for the
  // "channel_create mirrors its route" case below to still exercise a success.
  await prisma.teamMember.createMany({
    data: [
      { role: 'owner', teamId: team.id, userId: owner.id },
      { role: 'member', teamId: team.id, userId: member.id },
    ],
  })

  // The real home DM: `system_agent`, the `gagent:` dmKey, the blueprint's own
  // agent row — the surface every identity-delegated tool call arrives on.
  const bootstrap = await ensureGlobalAgentBootstrap(prisma, {
    blueprint: AGENT_DESIGNER_BLUEPRINT,
    organizationId: organization.id,
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

const cleanup = async (prisma: PrismaClient, team: Seed): Promise<void> => {
  await prisma.organization.deleteMany({
    where: { id: { in: [team.organizationId, team.otherOrganizationId] } },
  })
  await prisma.user.deleteMany({
    where: { id: { in: [team.memberId, team.ownerId] } },
  })
}

const buildContext = (
  prisma: PrismaClient,
  team: Seed,
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
        teamId: team.teamId,
      },
      actor: { actorId: actingUserId, actorType: 'user', roles: ['member'] },
      tenant: {
        organizationId: team.organizationId,
        projectId: team.projectId,
        teamId: team.teamId,
      },
    },
    agentId: team.agentId,
    agentKind: 'shared',
    channel: {
      id: team.homeChannelId,
      organizationId: team.organizationId,
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

// Where the Designer is told to read an id: the last path segment of a
// markdown link its tool returned, e.g. `[Marketing](/projects/<id>)`.
const idFromLink = (output: string, path: string): string => {
  const match = new RegExp(`\\]\\(/${path}/([0-9a-f-]{36})\\)`).exec(output)
  assert.ok(match, `expected a /${path}/… link in:\n${output}`)
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

runDatabaseTest('the Designer stands up a project and a channel in its team', async (t) => {
  const prisma = new PrismaClient()
  const team = await seed(prisma)
  t.after(() => cleanup(prisma, team).then(() => prisma.$disconnect()))
  const context = buildContext(prisma, team, team.ownerId)

  const projectResult = await runProjectCreateTool(context, {
    name: 'Marketing',
    teamId: team.teamId,
  })
  const projectId = idFromLink(projectResult.outputPreview, 'projects')

  // Deliberately no `visibility`: what the model omits must not publish a room
  // to the whole organisation.
  const channelResult = await runChannelCreateTool(context, {
    label: 'Launch plan',
    projectId,
    teamId: team.teamId,
  })
  const channelId = idFromLink(channelResult.outputPreview, 'channels')

  const channel = await prisma.channel.findUniqueOrThrow({
    where: { id: channelId },
    select: { organizationId: true, projectId: true, teamId: true, visibility: true },
  })
  assert.equal(channel.projectId, projectId, 'the channel belongs to the new project')
  assert.equal(channel.teamId, team.teamId)
  assert.equal(channel.organizationId, team.organizationId)
  assert.equal(channel.visibility, 'private')

  // One member each — the person who asked, and nobody else.
  assert.deepEqual(
    await prisma.projectMember.findMany({
      where: { projectId },
      select: { role: true, userId: true },
    }),
    [{ role: 'owner', userId: team.ownerId }],
  )
  assert.deepEqual(
    await prisma.channelMember.findMany({
      where: { channelId },
      select: { userId: true },
    }),
    [{ userId: team.ownerId }],
  )

  // The resolving read finds the project and its owning team, so names become
  // the ids the next write takes: the project's from its link, the team's
  // beside its name, since a team has no page to link.
  const listed = await runProjectListTool(context, { query: 'marketing' })
  assert.equal(idFromLink(listed.outputPreview, 'projects'), projectId)
  assert.match(listed.outputPreview, /^- \[Marketing\]\(\/projects\/[0-9a-f-]{36}\) \| teams: /m)
  assert.equal(idFrom(listed.outputPreview, 'teamId'), team.teamId)
  assert.doesNotMatch(listed.outputPreview, /projectId=/)

  // The mirroring claim, asserted: the same input through the function the
  // route calls produces the same row shape.
  const viaRoute = await createProjectForUser(prisma, {
    name: 'Marketing (clicked)',
    organizationId: team.organizationId,
    teamId: team.teamId,
    userId: team.ownerId,
  })
  const projectShape = {
    channelRoot: true,
    organizationId: true,
    boards: {
      select: {
        isDefault: true,
        name: true,
        style: true,
        columns: { select: { category: true, name: true }, orderBy: { position: 'asc' } },
      },
    },
    _count: { select: { members: true } },
  } as const
  const [viaTool, clicked] = await Promise.all([
    prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: projectShape }),
    prisma.project.findUniqueOrThrow({ where: { id: viaRoute.id }, select: projectShape }),
  ])
  assert.deepEqual(viaTool, clicked)
  // Not just equal to each other — actually the default board with its four
  // lifecycle columns, so the assertion cannot pass by both being empty.
  assert.equal(viaTool.boards.length, 1)
  assert.equal(viaTool.boards[0]?.isDefault, true)
  assert.deepEqual(viaTool.boards[0]?.columns.map((column) => column.category), [
    'todo',
    'in_progress',
    'review',
    'done',
  ])
})

runDatabaseTest('a plain member creates a project and a channel in it; team_create stays owner-only', async (t) => {
  const prisma = new PrismaClient()
  const team = await seed(prisma)
  t.after(() => cleanup(prisma, team).then(() => prisma.$disconnect()))
  const context = buildContext(prisma, team, team.memberId)

  const projectsBefore = await prisma.project.count({
    where: { organizationId: team.organizationId },
  })
  const teamsBefore = await prisma.team.count({
    where: { project: { organizationId: team.organizationId } },
  })

  // Any organisation member creates a project in a team they are in, and is its
  // only member (`createProjectForUser`, the same function `POST /api/projects`
  // calls).
  const projectResult = await runProjectCreateTool(context, { name: 'Marketing', teamId: team.teamId })
  const memberProjectId = idFromLink(projectResult.outputPreview, 'projects')
  assert.deepEqual(
    await prisma.projectMember.findMany({ where: { projectId: memberProjectId }, select: { userId: true } }),
    [{ userId: team.memberId }],
  )
  assert.equal(
    await prisma.project.count({ where: { organizationId: team.organizationId } }),
    projectsBefore + 1,
  )

  // Creating a team is still an organisation-owner action.
  const teamRefusal = await refusal(
    runTeamCreateTool(context, { name: 'Campaigns', projectId: team.projectId }),
  )
  assert.match(teamRefusal, /Only an organisation owner can create a team/)
  assert.equal(
    await prisma.team.count({
      where: { project: { organizationId: team.organizationId } },
    }),
    teamsBefore,
  )

  // `channel_create` mirrors `POST /api/channels`: standing in the team, and —
  // because adding a room changes the project — membership of the project
  // (`canModifyProject`). The member's own new project satisfies both.
  const channelResult = await runChannelCreateTool(context, {
    label: 'Member room',
    projectId: memberProjectId,
    teamId: team.teamId,
  })
  const channelId = idFromLink(channelResult.outputPreview, 'channels')
  const channel = await prisma.channel.findUniqueOrThrow({
    where: { id: channelId },
    select: { visibility: true },
  })
  assert.equal(channel.visibility, 'private')
})

runDatabaseTest('channel_create refuses a team the caller has no standing in', async (t) => {
  const prisma = new PrismaClient()
  const team = await seed(prisma)
  t.after(() => cleanup(prisma, team).then(() => prisma.$disconnect()))
  const context = buildContext(prisma, team, team.memberId)

  // A second team in the same organisation and project that `member` was
  // never added to — no `TeamMember` row, no `ProjectMember` row, and `member`
  // is not an organisation owner/admin, so `canPlaceChannelInTeam` has nothing
  // to grant standing on.
  const strangeTeam = await prisma.team.create({
    data: { name: 'Someone else\'s team', projectId: team.projectId },
  })

  const channelsBefore = await prisma.channel.count({ where: { teamId: strangeTeam.id } })

  const message = await refusal(
    runChannelCreateTool(context, {
      label: 'Trespassing room',
      projectId: team.projectId,
      teamId: strangeTeam.id,
    }),
  )
  // Refused on the project first: `member` is in neither the project nor the team.
  assert.match(message, /not a member of that (project|team)/)

  assert.equal(
    await prisma.channel.count({ where: { teamId: strangeTeam.id } }),
    channelsBefore,
  )
})

// A team has no page to link, so it keeps its teamId beside its name; the
// project it lands in is a link, and nothing tells the model what to do next.
runDatabaseTest('team_create names the team and links the project it is in', async (t) => {
  const prisma = new PrismaClient()
  const team = await seed(prisma)
  t.after(() => cleanup(prisma, team).then(() => prisma.$disconnect()))
  const context = buildContext(prisma, team, team.ownerId)

  const result = await runTeamCreateTool(context, { name: 'Campaigns', projectId: team.projectId })
  const created = await prisma.team.findFirstOrThrow({
    where: { name: 'Campaigns', projectId: team.projectId },
    select: { id: true },
  })
  const { name: projectName } = await prisma.project.findUniqueOrThrow({
    where: { id: team.projectId },
    select: { name: true },
  })
  assert.equal(
    result.outputPreview,
    `Created team "Campaigns" (teamId=${created.id}) in [${projectName}](/projects/${team.projectId})\n`
    + 'You are its only member and its owner — nobody else was added.',
  )
})

runDatabaseTest('team_create refuses a cross-organisation projectId', async (t) => {
  const prisma = new PrismaClient()
  const team = await seed(prisma)
  t.after(() => cleanup(prisma, team).then(() => prisma.$disconnect()))
  const context = buildContext(prisma, team, team.ownerId)

  const message = await refusal(
    runTeamCreateTool(context, {
      name: 'Campaigns',
      projectId: team.otherProjectId,
    }),
  )
  assert.match(message, /Project not found/)
  assert.equal(
    await prisma.team.count({ where: { projectId: team.otherProjectId } }),
    0,
  )
})

runDatabaseTest('project_list is scoped to the caller and their organisation', async (t) => {
  const prisma = new PrismaClient()
  const team = await seed(prisma)
  t.after(() => cleanup(prisma, team).then(() => prisma.$disconnect()))

  const ownerContext = buildContext(prisma, team, team.ownerId)
  const ownerProject = idFromLink(
    (await runProjectCreateTool(ownerContext, {
      name: 'Owner only',
      teamId: team.teamId,
    })).outputPreview,
    'projects',
  )

  // A project is created `public`, and a public project is readable by every
  // member of the organisation — the deliberate disclosure widening in
  // `docs/plans/2026-09-16-project-and-channel-visibility.md`. Membership is
  // what a PROTECTED project takes, so both halves are pinned here: the same
  // project is listed while public and gone once it is protected.
  const memberContext = buildContext(prisma, team, team.memberId)
  const asMemberWhilePublic = await runProjectListTool(memberContext, {})
  assert.ok(
    asMemberWhilePublic.outputPreview.includes(ownerProject),
    'a public project is listed for every member of the organisation',
  )

  await prisma.project.update({
    where: { id: ownerProject },
    data: { visibility: 'protected' },
  })
  const asMember = await runProjectListTool(memberContext, {})
  assert.ok(
    !asMember.outputPreview.includes(ownerProject),
    'a member never sees a PROTECTED project they do not belong to',
  )

  const asOwner = await runProjectListTool(ownerContext, {})
  assert.match(asOwner.outputPreview, new RegExp(`\\(/projects/${ownerProject}\\)`))
  assert.ok(
    !asOwner.outputPreview.includes(team.otherProjectId),
    'never another organisation',
  )
})

// F9: the Designer relays these outputs closely. It used to print
// `agentId=<uuid>` and `Its private home is channelId=<uuid>`, and the person
// read the UUIDs back in the reply. Against real rows: the links name the
// agent and the rooms the tools actually wrote, and no raw key=id is left.
runDatabaseTest('agent_create and agent_bind_channel hand back links, not ids', async (t) => {
  const prisma = new PrismaClient()
  const team = await seed(prisma)
  t.after(() => cleanup(prisma, team).then(() => prisma.$disconnect()))
  const base = buildContext(prisma, team, team.ownerId)
  // No project on the run's tenant: an agent homed in a project also writes
  // its canonical core document, which is not what this case is about.
  const context = {
    ...base,
    actorContext: {
      ...base.actorContext,
      tenant: { organizationId: team.organizationId, teamId: team.teamId },
    },
  } as BuiltinToolRuntimeContext
  const warn = console.warn
  console.warn = () => undefined
  t.after(() => { console.warn = warn })

  const privateResult = await runAgentCreateTool(context, { name: 'Night Owl', visibility: 'private' })
  const privateAgent = await prisma.agent.findFirstOrThrow({
    where: { name: 'Night Owl', organizationId: team.organizationId },
    select: { bindings: { select: { channelId: true } }, id: true },
  })
  const homeId = privateAgent.bindings[0]?.channelId
  assert.ok(homeId, 'a private agent is created with its home')
  const lines = privateResult.outputPreview.split('\n')
  assert.equal(lines[0], `Created agent [Night Owl](/agents/${privateAgent.id}) (assistant) | model=deployment default`)
  assert.equal(lines[1], `Lives in: its private home, [#Night Owl](/channels/${homeId}).`)
  // No model client on this run, so no picture — and the reason is data.
  assert.equal(lines[2], 'portrait: none (reason: "The model service is not configured.")')
  assert.doesNotMatch(privateResult.outputPreview, /agentId=|channelId=/)

  const projectResult = await runProjectCreateTool(base, { name: 'Night work', teamId: team.teamId })
  const channelResult = await runChannelCreateTool(base, {
    label: 'Launch plan',
    projectId: idFromLink(projectResult.outputPreview, 'projects'),
    teamId: team.teamId,
  })
  const channelId = idFromLink(channelResult.outputPreview, 'channels')
  const teamResult = await runAgentCreateTool(context, { name: 'Night Shift' })
  assert.match(teamResult.outputPreview, /^Lives in: nowhere yet — add it to any channel\.$/m)
  const teamAgentId = /\/agents\/([0-9a-f-]{36})\)/.exec(teamResult.outputPreview)?.[1]
  assert.ok(teamAgentId, 'the id a later call needs is the link\'s last segment')

  // The default an organisation is provisioned with: owners may bind agents.
  await prisma.policyRule.create({
    data: {
      action: 'bind',
      bindings: { create: { actorId: 'owner', actorType: 'role' } },
      createdBy: team.ownerId,
      effect: 'allow',
      organizationId: team.organizationId,
      priority: 10,
      resourceType: 'agent',
      scope: 'organization',
      scopeId: team.organizationId,
    },
  })
  const bound = await runAgentBindChannelTool(context, { agentId: teamAgentId, channelId })
  // The room's stored name, which is the slugged label a person sees.
  const { label } = await prisma.channel.findUniqueOrThrow({ where: { id: channelId }, select: { label: true } })
  assert.equal(
    bound.outputPreview,
    `Bound [Night Shift](/agents/${teamAgentId}) to [#${label}](/channels/${channelId}). `
    + 'It now answers in that channel.',
  )
  assert.equal(await prisma.agentBinding.count({ where: { agentId: teamAgentId, channelId } }), 1)
})

// The same for the three tools that still printed `projectId=`, `agentId=` and
// `triggerId=`: project_create, agent_list and agent_trigger_create answer with
// links, and each id the next call takes is read out of a link exactly as the
// Designer is told to — and that call accepts it, against real rows.
runDatabaseTest('project_create, agent_list and agent_trigger_create hand back links the next call reads', async (t) => {
  const prisma = new PrismaClient()
  const team = await seed(prisma)
  t.after(() => cleanup(prisma, team).then(() => prisma.$disconnect()))
  const context = {
    ...buildContext(prisma, team, team.ownerId),
    // agent_trigger_update announces the agent it changed.
    realtimeTransport: { publishWs: async () => undefined },
  } as unknown as BuiltinToolRuntimeContext

  // project_create → channel_create, with the projectId from the link and the
  // teamId from the result too — never only from the call's own arguments,
  // which a compacted conversation may no longer hold.
  const projectResult = await runProjectCreateTool(context, { name: 'Night work', teamId: team.teamId })
  const projectId = idFromLink(projectResult.outputPreview, 'projects')
  const { name: teamName } = await prisma.team.findUniqueOrThrow({ where: { id: team.teamId }, select: { name: true } })
  assert.equal(
    projectResult.outputPreview.split('\n')[0],
    `Created project [Night work](/projects/${projectId}) in team "${teamName}" (teamId=${team.teamId})`,
  )
  assert.doesNotMatch(projectResult.outputPreview, /projectId=/)
  const channelResult = await runChannelCreateTool(context, {
    label: 'Night desk',
    projectId,
    teamId: idFrom(projectResult.outputPreview, 'teamId'),
  })
  const channelId = idFromLink(channelResult.outputPreview, 'channels')
  assert.doesNotMatch(channelResult.outputPreview, /channelId=|projectId=/)
  const channel = await prisma.channel.findUniqueOrThrow({
    where: { id: channelId },
    select: { label: true, projectId: true },
  })
  assert.equal(channel.projectId, projectId, 'the id read from the link is the project that was made')

  // agent_list → agent_update, with the agentId from the row's link.
  const agent = await prisma.agent.create({
    data: { name: 'Night Watch', organizationId: team.organizationId, role: 'monitor', teamId: team.teamId },
  })
  await prisma.agentBinding.create({ data: { agentId: agent.id, channelId } })
  const listed = await runAgentListTool(context, { query: 'night watch' })
  const row = listed.outputPreview.split('\n').find((line) => line.includes('Night Watch')) ?? ''
  assert.equal(row, `- [Night Watch](/agents/${agent.id}) | role=monitor | [#${channel.label}](/channels/${channelId})`)
  assert.doesNotMatch(listed.outputPreview, /agentId=|channelId=/)
  const updated = await runAgentUpdateTool(context, { agentId: idFromLink(row, 'agents'), role: 'night monitor' })
  assert.match(updated.outputPreview, /^Updated agent "Night Watch" \(night monitor\)$/m)
  assert.equal(
    (await prisma.agent.findUniqueOrThrow({ where: { id: agent.id }, select: { role: true } })).role,
    'night monitor',
  )

  // agent_trigger_create → agent_trigger_update, with the triggerId from the link.
  const armed = await runAgentTriggerCreateTool(context, {
    agentId: agent.id,
    config: { prompt: 'Check the night queue' },
    name: 'Night sweep',
    targetChannelId: channelId,
    type: 'manual',
  })
  const trigger = await prisma.agentTrigger.findFirstOrThrow({ where: { agentId: agent.id }, select: { id: true } })
  assert.equal(
    armed.outputPreview,
    `Created manual trigger [Night sweep](/agents/triggers/${trigger.id}) for [Night Watch](/agents/${agent.id})\n`
    + `status=active | posts into [#${channel.label}](/channels/${channelId})`,
  )
  // agent_trigger_list names the same trigger by the same link.
  const triggers = await runAgentTriggerListTool(context, { agentId: idFromLink(row, 'agents') })
  assert.equal(
    triggers.outputPreview,
    `- [Night sweep](/agents/triggers/${trigger.id}) | type=manual | status=active | enabled=true`,
  )
  const paused = await runAgentTriggerUpdateTool(context, {
    enabled: false,
    triggerId: idFromLink(triggers.outputPreview, 'agents/triggers'),
  })
  assert.equal(paused.outputPreview, `Updated [Night sweep](/agents/triggers/${trigger.id}) | status=paused | enabled=false`)
  assert.equal(
    (await prisma.agentTrigger.findUniqueOrThrow({ where: { id: trigger.id }, select: { enabled: true } })).enabled,
    false,
  )
})

