import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { AGENT_DESIGNER_BLUEPRINT, ensureGlobalAgentBootstrap } from '@nessie/team-admin'

import { runAgentTriggerUpdateTool } from '../../src/run/pa-tools/agent-lifecycle.js'
import { runAgentTriggerCreateTool } from '../../src/run/pa-tools/provisioning.js'
import { runProjectStructureReadTool } from '../../src/run/pa-tools/provisioning-structure.js'
import type { BuiltinToolRuntimeContext } from '../../src/run/tool-types.js'
import { runDatabaseTest } from './support.js'

/**
 * The Agent Designer setting up a ticket-driven agent, against real rows in
 * its bootstrapped home DM (docs/plans/2026-09-23-ticket-driven-agents,
 * setup-and-ui.md "What the Designer needs"): `project_structure_read` shows
 * the project's boards, columns, channels and spaces — only what the person
 * asking can see — and `agent_trigger_create` resolves a `ticket_changed`
 * trigger from those names, refuses field by field, and says back what it
 * resolved as links.
 *
 * Cleanup is scoped to this suite's own organisation.
 */

const seed = async (prisma: PrismaClient) => {
  const suffix = randomUUID()
  const owner = await prisma.user.create({ data: { displayName: 'Owner', email: `dtt-owner-${suffix}@example.test` } })
  const member = await prisma.user.create({ data: { displayName: 'Member', email: `dtt-member-${suffix}@example.test` } })
  const organization = await prisma.organization.create({ data: { name: `designer-ticket-${suffix}` } })
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: organization.id, role: 'owner', userId: owner.id },
      { organizationId: organization.id, role: 'member', userId: member.id },
    ],
  })
  const project = await prisma.project.create({ data: { name: 'Nessie', organizationId: organization.id } })
  const secretProject = await prisma.project.create({ data: { name: 'Secret', organizationId: organization.id } })
  await prisma.projectMember.createMany({
    data: [
      { projectId: project.id, role: 'owner', userId: owner.id },
      { projectId: project.id, role: 'member', userId: member.id },
    ],
  })
  const team = await prisma.team.create({ data: { name: `team-${suffix}`, projectId: project.id } })
  await prisma.teamMember.createMany({
    data: [
      { role: 'owner', teamId: team.id, userId: owner.id },
      { role: 'member', teamId: team.id, userId: member.id },
    ],
  })
  const board = await prisma.board.create({
    data: { isDefault: true, name: 'Engineering', organizationId: organization.id, position: 0, projectId: project.id },
  })
  const columns: Record<string, string> = {}
  for (const [position, [name, category]] of ([
    ['Backlog', 'todo'], ['In progress', 'in_progress'], ['Review', 'review'], ['Done', 'done'],
  ] as const).entries()) {
    columns[name] = (await prisma.boardColumn.create({
      data: { boardId: board.id, category, name, organizationId: organization.id, position },
    })).id
  }
  const channel = (label: string, visibility: 'public' | 'protected', memberIds: string[] = []) =>
    prisma.channel.create({
      data: {
        label,
        members: { create: memberIds.map((userId) => ({ userId })) },
        organizationId: organization.id,
        projectId: project.id,
        slug: `${label}-${suffix}`,
        teamId: team.id,
        visibility,
      },
      select: { id: true },
    })
  const eng = await channel('eng', 'public')
  const leads = await channel('leads', 'protected', [owner.id])
  const crew = await channel('crew', 'protected', [member.id, owner.id])
  const cto = await prisma.agent.create({
    data: { name: 'CTO', organizationId: organization.id, projectId: project.id, visibility: 'team' },
  })
  await prisma.agentBinding.createMany({
    data: [{ agentId: cto.id, channelId: eng.id }, { agentId: cto.id, channelId: crew.id }],
  })
  const space = await prisma.knowledgeSpace.create({
    data: { createdBy: owner.id, name: 'Tech docs', organizationId: organization.id, projectId: project.id },
  })
  const page = (title: string, kind: 'document' | 'folder', parentPageId?: string) =>
    prisma.knowledgePage.create({
      data: {
        createdBy: owner.id,
        kind,
        organizationId: organization.id,
        parentPageId,
        projectId: project.id,
        spaceId: space.id,
        title,
      },
      select: { id: true },
    })
  const specs = await page('Specs', 'folder')
  await page('Nested folder', 'folder', specs.id)
  await page('Readme', 'document')
  await prisma.knowledgeSpace.create({
    data: {
      createdBy: owner.id,
      name: 'Owner notes',
      organizationId: organization.id,
      projectId: project.id,
      visibility: 'private',
    },
  })
  const designer = await ensureGlobalAgentBootstrap(prisma, {
    blueprint: AGENT_DESIGNER_BLUEPRINT,
    organizationId: organization.id,
    teamId: team.id,
    userId: owner.id,
  })
  return {
    boardId: board.id,
    columns,
    crewId: crew.id,
    ctoId: cto.id,
    designerAgentId: designer.agentId,
    engId: eng.id,
    homeChannelId: designer.channelId,
    leadsId: leads.id,
    memberId: member.id,
    organizationId: organization.id,
    ownerId: owner.id,
    projectId: project.id,
    secretProjectId: secretProject.id,
    specsId: specs.id,
    spaceId: space.id,
    teamId: team.id,
    cleanup: async () => {
      await prisma.organization.deleteMany({ where: { id: organization.id } })
      await prisma.user.deleteMany({ where: { id: { in: [owner.id, member.id] } } })
    },
  }
}
type Seed = Awaited<ReturnType<typeof seed>>

const buildContext = (prisma: PrismaClient, s: Seed, actingUserId: string): BuiltinToolRuntimeContext =>
  ({
    actorContext: {
      actionContext: {
        effectiveUserId: actingUserId,
        requestId: `designer-ticket-${randomUUID()}`,
        teamId: s.teamId,
      },
      actor: { actorId: actingUserId, actorType: 'user', roles: ['member'] },
      tenant: { organizationId: s.organizationId, projectId: s.projectId, teamId: s.teamId },
    },
    agentId: s.designerAgentId,
    agentKind: 'shared',
    channel: { id: s.homeChannelId, organizationId: s.organizationId, systemChannelType: 'system_agent' },
    consumedSources: new Set(),
    ledgerIdentity: null,
    prisma,
    realtimeTransport: { publishWs: async () => {} } as unknown as BuiltinToolRuntimeContext['realtimeTransport'],
    run: { id: randomUUID(), interactive: true, messageId: randomUUID(), threadId: randomUUID() },
    toolCallId: randomUUID(),
  }) as unknown as BuiltinToolRuntimeContext

const refusal = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected the tool to refuse')
}

runDatabaseTest('project_structure_read returns only what the person asking can see', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(() => s.cleanup().then(() => prisma.$disconnect()))

  const read = await runProjectStructureReadTool(buildContext(prisma, s, s.memberId), {
    agentId: s.ctoId,
    projectId: s.projectId,
  })
  const text = read.outputPreview
  assert.match(text, new RegExp(`^Project \\[Nessie\\]\\(/projects/${s.projectId}\\), as seen for \\[CTO\\]`))
  // The board as a link, every column with its category and id.
  assert.ok(text.includes(
    `- [Engineering](/projects/${s.projectId}/board?board=${s.boardId}) (boardId=${s.boardId}) — the default board`,
  ))
  for (const [name, category] of [['Backlog', 'todo'], ['In progress', 'in_progress'], ['Done', 'done']]) {
    assert.ok(text.includes(`  - ${name} (${category}) | columnId=${s.columns[name]}`), name)
  }
  // Channels: the public one and the protected one they are in, never the
  // protected one they are not in. Each says whether the agent is in it.
  assert.ok(text.includes(`- [#eng](/channels/${s.engId}) (channelId=${s.engId}) | public | CTO is in it`))
  assert.ok(text.includes(`- [#crew](/channels/${s.crewId}) (channelId=${s.crewId}) | protected | CTO is in it`))
  assert.doesNotMatch(text, /#leads/)
  // Spaces they can read, with top-level folders only.
  assert.ok(text.includes(`Tech docs (spaceId=${s.spaceId}, visibility=project) | top-level folders: Specs (pageId=${s.specsId})`))
  assert.doesNotMatch(text, /Nested folder|Readme|Owner notes/)

  // The owner sees their own protected room too, and the same board.
  const ownerRead = await runProjectStructureReadTool(buildContext(prisma, s, s.ownerId), { projectId: s.projectId })
  assert.ok(ownerRead.outputPreview.includes(`- [#leads](/channels/${s.leadsId}) (channelId=${s.leadsId}) | protected`))
  assert.doesNotMatch(ownerRead.outputPreview, /is in it|is not in it/, 'no agent named, no placements')

  // A project they are not in reads as missing.
  assert.equal(
    await refusal(runProjectStructureReadTool(buildContext(prisma, s, s.memberId), { projectId: s.secretProjectId })),
    'Project not found, or you are not in it. Resolve it with project_list.',
  )
})

runDatabaseTest('the Designer creates a ticket trigger from names, refused field by field', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(() => s.cleanup().then(() => prisma.$disconnect()))
  const context = buildContext(prisma, s, s.ownerId)
  const instructions = { general: 'Read the ticket and its comments before you act.' }

  // A typo in a column name is refused by its path, listing the columns.
  assert.equal(
    await refusal(runAgentTriggerCreateTool(context, {
      agentId: s.ctoId,
      config: { instructions, pickup: { columns: [{ name: 'In Progres' }] } },
      targetChannelId: s.engId,
      type: 'ticket_changed',
    })),
    'pickup.columns[0]: no column "In Progres" on board Engineering (columns: Backlog, In progress, Review, Done)',
  )
  // A protected channel is refused, saying why it must be public.
  assert.match(
    await refusal(runAgentTriggerCreateTool(context, {
      agentId: s.ctoId,
      config: { instructions },
      targetChannelId: s.crewId,
      type: 'ticket_changed',
    })),
    /^targetChannelId: #crew is protected\. A ticket trigger's channel must be public/,
  )

  const created = await runAgentTriggerCreateTool(context, {
    agentId: s.ctoId,
    config: { instructions, pickup: { columns: [{ category: 'in_progress' }] } },
    name: 'CTO pickup',
    targetChannelId: s.engId,
    type: 'ticket_changed',
  })
  const trigger = await prisma.agentTrigger.findFirstOrThrow({ where: { agentId: s.ctoId } })
  assert.equal(trigger.scopeBoardId, s.boardId)
  const board = `[Engineering](/projects/${s.projectId}/board?board=${s.boardId})`
  assert.equal(
    created.outputPreview,
    [
      `Created ticket_changed trigger [CTO pickup](/agents/triggers/${trigger.id}) for [CTO](/agents/${s.ctoId})`,
      `status=active | each ticket's work thread opens in [#eng](/channels/${s.engId})`,
      `Starts work when a person who can edit ${board} moves a ticket into `
      + `In progress (in_progress, columnId=${s.columns['In progress']}), and assigns an unassigned ticket to the agent`,
      `Ends the work in Backlog (todo, columnId=${s.columns['Backlog']}), Done (done, columnId=${s.columns['Done']})`,
      'Wakes the agent on: comment, description, moved, thread_message, document',
      // Board tools are off by default: the answer says which the agent lacks.
      'CTO cannot use ticket_read, ticket_comment_add, ticket_move yet, so a wake would give it no way to work '
      + 'the ticket: set them true with agent_tool_access_set before a ticket is moved.',
    ].join('\n'),
  )

  // Granted, the warning goes; an edit names only what it changes, and says
  // back what it resolved.
  await prisma.agent.update({
    where: { id: s.ctoId },
    data: { toolPolicy: { ticket_read: true, ticket_comment_add: true, ticket_move: true } },
  })
  const updated = await runAgentTriggerUpdateTool(context, {
    config: { follow: { kinds: ['comment', 'priority'] }, pickup: { assignOnPickup: false, columns: [{ name: 'Review' }] } },
    triggerId: trigger.id,
  })
  assert.match(updated.outputPreview, new RegExp(`moves a ticket into Review \\(review, columnId=${s.columns['Review']}\\)\\n`))
  assert.match(updated.outputPreview, /Wakes the agent on: comment, priority$/)
  assert.deepEqual(
    ((await prisma.agentTrigger.findUniqueOrThrow({ where: { id: trigger.id } })).config as Record<string, unknown>)['instructions'],
    instructions,
  )
})
