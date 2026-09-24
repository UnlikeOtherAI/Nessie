import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { visibleUserAlertWhere } from '@nessie/db'
import { PROJECT_OPERATOR_TOOL_IDS } from '@nessie/runtime'
import { TICKET_WORK_PURPOSE } from '@nessie/schemas'

import { createConsumedSourceSink } from '../../src/run/execute/disclosure-basis.js'
import { resolveRunProjectOperatorToolIds } from '../../src/run/project-operator-admission.js'
import { runAgentTriggerUpdateTool } from '../../src/run/pa-tools/agent-lifecycle.js'
import { runTicketBoardCreateTool } from '../../src/run/pa-tools/peer-delegation.js'
import { runAgentTriggerCreateTool, runChannelCreateTool } from '../../src/run/pa-tools/provisioning.js'
import {
  runKbSpaceCreateTool,
  runTicketBoardColumnCreateTool,
  runTicketBoardColumnUpdateTool,
} from '../../src/run/pa-tools/project-operator-tools.js'
import { runProjectCreateTool, runProjectListTool, runTeamCreateTool } from '../../src/run/pa-tools/team-structure.js'
import { runTicketLabelCreateTool } from '../../src/run/pa-tools/ticket-labels.js'
import {
  runWorkflowCreateTool,
  runWorkflowInstallTool,
  runWorkflowTriggerCreateTool,
} from '../../src/run/pa-tools/workflow-authoring.js'
import type { BuiltinToolRuntimeContext } from '../../src/run/tool-types.js'
import { runDatabaseTest } from './support.js'

/**
 * The project-operator capability against real rows
 * (docs/plans/2026-09-23-ticket-driven-agents/setup-and-ui.md → "The
 * project-operator capability"; verification.md → "T6"): a CTO bound to
 * #eng of project Nessie, holding `project_operator`, set up projects and
 * flows for the person talking to it — as that person, refused wherever they
 * would be — and never on a trigger, a schedule or ticket work.
 *
 * Cleanup is scoped to this suite's own organisation.
 */

const seed = async (prisma: PrismaClient) => {
  const suffix = randomUUID()
  const user = (name: string) =>
    prisma.user.create({ data: { displayName: name, email: `op-${name.toLowerCase()}-${suffix}@example.test` } })
  const [owner, member, outsider] = [await user('Owner'), await user('Member'), await user('Outsider')]
  const organization = await prisma.organization.create({ data: { name: `project-operator-${suffix}` } })
  // The default rule every organisation is seeded with (`seedDefaultPolicies`):
  // anyone may create a knowledge space, subject to the project gate.
  await prisma.policyRule.create({
    data: {
      action: 'create',
      bindings: { create: { actorId: '*', actorType: 'role' } },
      createdBy: owner.id,
      effect: 'allow',
      organizationId: organization.id,
      priority: 100,
      resourceType: 'knowledge_space',
      scope: 'organization',
      scopeId: organization.id,
      seedKey: 'default:knowledge_space:create:allow:*',
    },
  })
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: organization.id, role: 'owner', userId: owner.id },
      { organizationId: organization.id, role: 'member', userId: member.id },
      { organizationId: organization.id, role: 'member', userId: outsider.id },
    ],
  })
  const project = await prisma.project.create({ data: { name: 'Nessie', organizationId: organization.id } })
  const other = await prisma.project.create({ data: { name: 'Other', organizationId: organization.id } })
  await prisma.projectMember.createMany({
    data: [
      { projectId: project.id, role: 'owner', userId: owner.id },
      { projectId: project.id, role: 'member', userId: member.id },
      { projectId: other.id, role: 'owner', userId: owner.id },
    ],
  })
  const team = await prisma.team.create({ data: { name: `team-${suffix}`, projectId: project.id } })
  const otherTeam = await prisma.team.create({ data: { name: `other-team-${suffix}`, projectId: other.id } })
  await prisma.teamMember.createMany({
    data: [
      { role: 'owner', teamId: team.id, userId: owner.id },
      { role: 'member', teamId: team.id, userId: member.id },
      { role: 'owner', teamId: otherTeam.id, userId: owner.id },
    ],
  })
  const board = await prisma.board.create({
    data: { isDefault: true, name: 'Engineering', organizationId: organization.id, position: 0, projectId: project.id },
  })
  for (const [position, [name, category]] of ([['Backlog', 'todo'], ['In progress', 'in_progress'], ['Done', 'done']] as const).entries()) {
    await prisma.boardColumn.create({
      data: { boardId: board.id, category, name, organizationId: organization.id, position },
    })
  }
  const channel = (projectId: string, teamId: string, label: string) =>
    prisma.channel.create({
      data: { label, organizationId: organization.id, projectId, slug: `${label}-${suffix}`, teamId, visibility: 'public' },
      select: { id: true },
    })
  const eng = await channel(project.id, team.id, 'eng')
  const elsewhere = await channel(other.id, otherTeam.id, 'elsewhere')
  const agent = (name: string, toolPolicy: Record<string, boolean>) =>
    prisma.agent.create({
      data: { name, organizationId: organization.id, projectId: project.id, toolPolicy, visibility: 'team' },
      select: { id: true },
    })
  const cto = await agent('CTO', { project_operator: true })
  // Another team agent, working only in the other project.
  const scout = await agent('Scout', {})
  await prisma.agentBinding.createMany({
    data: [
      { agentId: cto.id, channelId: eng.id },
      { agentId: cto.id, channelId: elsewhere.id },
      { agentId: scout.id, channelId: elsewhere.id },
    ],
  })
  return {
    boardId: board.id,
    ctoId: cto.id,
    elsewhereId: elsewhere.id,
    engId: eng.id,
    memberId: member.id,
    organizationId: organization.id,
    otherProjectId: other.id,
    outsiderId: outsider.id,
    ownerId: owner.id,
    projectId: project.id,
    scoutId: scout.id,
    teamId: team.id,
    cleanup: async () => {
      await prisma.organization.deleteMany({ where: { id: organization.id } })
      await prisma.user.deleteMany({ where: { id: { in: [owner.id, member.id, outsider.id] } } })
    },
  }
}
type Seed = Awaited<ReturnType<typeof seed>>

type RunShape = {
  actorType?: 'agent' | 'user'
  channelId?: string
  effectiveUserId?: string
  interactive?: boolean
  purpose?: string
}

/** The CTO's run in #eng, as the person `actingUserId` asking it — or a variation of that run. */
const buildContext = (
  prisma: PrismaClient,
  s: Seed,
  actingUserId: string,
  shape: RunShape = {},
): BuiltinToolRuntimeContext =>
  ({
    actorContext: {
      actionContext: {
        requestId: `project-operator-${randomUUID()}`,
        teamId: s.teamId,
        ...(shape.effectiveUserId ? { effectiveUserId: shape.effectiveUserId } : {}),
        ...(shape.purpose ? { purpose: shape.purpose } : {}),
      },
      actor: { actorId: shape.actorType === 'agent' ? s.ctoId : actingUserId, actorType: shape.actorType ?? 'user', roles: ['member'] },
      tenant: { organizationId: s.organizationId, projectId: s.projectId, teamId: s.teamId },
    },
    agentId: s.ctoId,
    agentKind: 'shared',
    channel: {
      id: shape.channelId ?? s.engId,
      organizationId: s.organizationId,
      projectId: shape.channelId === s.elsewhereId ? s.otherProjectId : s.projectId,
      systemChannelType: null,
    },
    consumedSources: createConsumedSourceSink(),
    ledgerIdentity: null,
    prisma,
    realtimeTransport: { publishWs: async () => {} } as unknown as BuiltinToolRuntimeContext['realtimeTransport'],
    run: { id: randomUUID(), interactive: shape.interactive ?? true, messageId: randomUUID(), threadId: randomUUID() },
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

const ARM_REFUSAL = /works only on their own turn in a project channel you are in/

runDatabaseTest('the operator arm opens only on a live requester\'s turn, and every verb re-checks it', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(() => s.cleanup().then(() => prisma.$disconnect()))

  const admission = (
    shape: RunShape & { agentId?: string; toolPolicy?: Record<string, boolean> },
  ) => resolveRunProjectOperatorToolIds(prisma, {
    actorId: shape.actorType === 'agent' ? s.ctoId : s.ownerId,
    actorType: shape.actorType ?? 'user',
    agentId: shape.agentId ?? s.ctoId,
    agentKind: 'shared',
    channel: { dmKey: null, systemChannelType: null },
    channelId: shape.channelId ?? s.engId,
    effectiveUserId: shape.effectiveUserId ?? null,
    interactive: shape.interactive ?? true,
    organizationId: s.organizationId,
    parentAgentId: null,
    purpose: shape.purpose,
    systemManaged: false,
    systemSlug: null,
    toolPolicy: shape.toolPolicy ?? { project_operator: true },
  })
  assert.deepEqual([...await admission({})], [...PROJECT_OPERATOR_TOOL_IDS])
  // A run with nobody to act as says so in its own words first; one that has
  // somebody still is not a live requester's.
  const NOBODY = /requires a user actor context/
  const TICKET_WORK = /acts for a person, and ticket work has none behind it/
  const refusedRuns: Array<[string, RunShape, RegExp]> = [
    ['a trigger fire', { actorType: 'agent' }, NOBODY],
    [
      'a scheduled fire, which reconstructs its creator',
      { actorType: 'agent', effectiveUserId: s.ownerId, interactive: false },
      ARM_REFUSAL,
    ],
    // Ticket work acts as the agent, with no person behind it.
    ['ticket work', { actorType: 'agent', purpose: TICKET_WORK_PURPOSE }, TICKET_WORK],
    // Even a ticket-work kickoff that somehow carried a person is no live turn.
    ['ticket work carrying a person', { purpose: TICKET_WORK_PURPOSE }, ARM_REFUSAL],
    ['a peer delegation', { purpose: 'agent.peer_delegation' }, ARM_REFUSAL],
    ['a channel the agent is not bound to', { channelId: randomUUID() }, ARM_REFUSAL],
  ]
  for (const [name, shape, expected] of refusedRuns) {
    assert.equal((await admission(shape)).size, 0, name)
    // The handler refuses the same run on its own, whatever the schema said.
    const context = buildContext(prisma, s, s.ownerId, shape)
    assert.match(await refusal(runProjectCreateTool(context, { name: 'Sneaky', teamId: s.teamId })), expected, name)
  }
  // The admission's other half: a run whose agent holds no grant.
  assert.equal((await admission({ agentId: s.scoutId, channelId: s.elsewhereId, toolPolicy: {} })).size, 0)

  // A grant taken back after the run began is refused at the call.
  await prisma.agent.update({ where: { id: s.ctoId }, data: { toolPolicy: {} } })
  assert.match(
    await refusal(runProjectListTool(buildContext(prisma, s, s.ownerId), {})),
    ARM_REFUSAL,
  )
  assert.equal(await prisma.project.count({ where: { name: 'Sneaky', organizationId: s.organizationId } }), 0)
})

runDatabaseTest('each operator verb acts as the person asking, and is refused beyond their rights', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(() => s.cleanup().then(() => prisma.$disconnect()))
  const asOwner = buildContext(prisma, s, s.ownerId)
  const asMember = buildContext(prisma, s, s.memberId)
  const asOutsider = buildContext(prisma, s, s.outsiderId)

  // project_create: the member's own project, with them as its only member.
  const created = await runProjectCreateTool(asMember, { name: 'Mobile', teamId: s.teamId })
  const mobile = await prisma.project.findFirstOrThrow({
    where: { name: 'Mobile', organizationId: s.organizationId },
    select: { id: true, members: { select: { userId: true } } },
  })
  assert.match(created.outputPreview, new RegExp(`\\[Mobile\\]\\(/projects/${mobile.id}\\)`))
  assert.deepEqual(mobile.members.map((row) => row.userId), [s.memberId])
  // Someone outside the team may not.
  assert.match(
    await refusal(runProjectCreateTool(asOutsider, { name: 'Nope', teamId: s.teamId })),
    /not allowed to create a project in that team/,
  )
  // team_create is an organisation owner's.
  assert.match(
    await refusal(runTeamCreateTool(asMember, { name: 'Squad', projectId: s.projectId })),
    /^Only an organisation owner can create a team/,
  )

  // channel_create: the owner's, and protected when nothing was asked for.
  await runChannelCreateTool(asOwner, { label: 'mobile-dev', projectId: s.projectId, teamId: s.teamId })
  const room = await prisma.channel.findFirstOrThrow({
    where: { label: 'mobile-dev', organizationId: s.organizationId },
    select: { members: { select: { userId: true } }, visibility: true },
  })
  assert.equal(room.visibility, 'protected')
  assert.deepEqual(room.members.map((row) => row.userId), [s.ownerId])

  // ticket_board_create reaches a project the person can change — the new one
  // included — and refuses one they cannot.
  await runTicketBoardCreateTool(asMember, { name: 'Mobile board', projectId: mobile.id })
  assert.equal(await prisma.board.count({ where: { name: 'Mobile board', projectId: mobile.id } }), 1)
  assert.match(
    await refusal(runTicketBoardCreateTool(asMember, { name: 'Not mine', projectId: s.otherProjectId })),
    /cannot change that project/,
  )

  // Columns: any project member, as in Board settings; a non-editor is refused.
  const column = await runTicketBoardColumnCreateTool(asMember, { boardId: s.boardId, category: 'review', name: 'Review' })
  const review = await prisma.boardColumn.findFirstOrThrow({ where: { boardId: s.boardId, name: 'Review' } })
  assert.match(column.outputPreview, new RegExp(`^Added column Review \\(review, columnId=${review.id}\\) to \\[Engineering\\]`))
  assert.match(
    await refusal(runTicketBoardColumnCreateTool(asOutsider, { boardId: s.boardId, category: 'todo', name: 'Mine' })),
    /cannot change that project/,
  )
  await runTicketBoardColumnUpdateTool(asMember, { boardId: s.boardId, category: 'in_progress', columnId: review.id, name: 'Doing' })
  const changed = await prisma.boardColumn.findUniqueOrThrow({ where: { id: review.id } })
  assert.deepEqual([changed.name, changed.category], ['Doing', 'in_progress'])

  // ticket_label_create on the operator arm alone (no lend of its own).
  await runTicketLabelCreateTool(asMember, { name: 'mobile' })
  assert.equal(await prisma.taskLabel.count({ where: { boardId: s.boardId, name: 'mobile' } }), 1)

  // kb_space_create: the project's documents space, idempotently, and a named
  // one; only a member of the project may.
  const docs = await runKbSpaceCreateTool(asMember, { kind: 'project_documents' })
  assert.match(docs.outputPreview, /^Created Project Documents of project "Nessie"/)
  assert.match((await runKbSpaceCreateTool(asMember, { kind: 'project_documents' })).outputPreview, /^Already there:/)
  await runKbSpaceCreateTool(asMember, { kind: 'space', name: 'Tech docs' })
  assert.equal(await prisma.knowledgeSpace.count({ where: { name: 'Tech docs', projectId: s.projectId, visibility: 'project' } }), 1)
  assert.match(
    await refusal(runKbSpaceCreateTool(asOutsider, { kind: 'space', name: 'Leak' })),
    /Only a member of that project/,
  )

  // Workflows: an owner's, and the trigger records who set it up.
  assert.match(
    await refusal(runWorkflowCreateTool(asMember, { graph: { steps: [{ id: 'read', input: { toolName: 'state_get' }, type: 'tool_call' }] }, name: 'x' })),
    /^Only an organisation owner can create a workflow/,
  )
  const workflow = await runWorkflowCreateTool(asOwner, {
    graph: { steps: [{ id: 'read', input: { toolName: 'state_get' }, type: 'tool_call' }] },
    name: 'Nightly check',
  })
  const workflowTemplateId = /workflowTemplateId=([0-9a-f-]{36})/.exec(workflow.outputPreview)![1]!
  const installed = await runWorkflowInstallTool(asOwner, { workflowTemplateId })
  const workflowInstallationId = /workflowInstallationId=([0-9a-f-]{36})/.exec(installed.outputPreview)![1]!
  await runWorkflowTriggerCreateTool(asOwner, { type: 'manual', workflowInstallationId })
  const workflowTrigger = await prisma.agentTrigger.findFirstOrThrow({ where: { workflowInstallationId } })
  assert.equal((workflowTrigger.config as Record<string, unknown>)['authorUserId'], s.ownerId)
})

runDatabaseTest('a ticket trigger the operator sets up stays in its project and leaves machine access to the owner', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(() => s.cleanup().then(() => prisma.$disconnect()))
  const asOwner = buildContext(prisma, s, s.ownerId)
  const trigger = (context: BuiltinToolRuntimeContext, agentId: string, targetChannelId: string) =>
    runAgentTriggerCreateTool(context, {
      agentId,
      config: { instructions: { general: 'Read the ticket first.' }, pickup: { columns: [{ name: 'In progress' }] } },
      name: 'CTO pickup',
      targetChannelId,
      type: 'ticket_changed',
    })

  // Only an organisation owner creates a trigger, as on the Triggers page.
  assert.match(
    await refusal(trigger(buildContext(prisma, s, s.memberId), s.ctoId, s.engId)),
    /^Only an organisation owner/,
  )
  // Not itself in a project it is not working in, even where it is bound…
  assert.equal(
    await refusal(trigger(asOwner, s.ctoId, s.elsewhereId)),
    'targetChannelId: that channel is in another project; from here a trigger works only in this project, '
    + 'in a channel of it the agent is in',
  )
  // …nor an agent that works only in another project.
  assert.equal(
    await refusal(trigger(asOwner, s.scoutId, s.elsewhereId)),
    'agentId: from here you can set up triggers only for yourself or an agent in one of this project\'s channels',
  )

  const created = await trigger(asOwner, s.ctoId, s.engId)
  const row = await prisma.agentTrigger.findFirstOrThrow({ where: { agentId: s.ctoId, type: 'ticket_changed' } })
  assert.equal((row.config as Record<string, unknown>)['authorUserId'], s.ownerId)
  assert.match(
    created.outputPreview,
    /\nMachine access: not set up\. The owner of the machines the work runs on sets it up/,
  )

  // The attention item is the requester's, names the trigger, and surfaces.
  const alerts = await prisma.userAlert.findMany({
    where: { ...visibleUserAlertWhere({ organizationId: s.organizationId, userId: s.ownerId }), kind: 'trigger_machine_access' },
    select: { actorAgentId: true, projectId: true, triggerId: true },
  })
  assert.deepEqual(alerts, [{ actorAgentId: s.ctoId, projectId: s.projectId, triggerId: row.id }])
  // Asked twice, it is still one item.
  await runAgentTriggerUpdateTool(asOwner, { name: 'CTO pickup (renamed)', triggerId: row.id })
  assert.equal(await prisma.userAlert.count({ where: { kind: 'trigger_machine_access', triggerId: row.id } }), 1)
  // A demoted owner keeps no doorway into it.
  await prisma.organizationMember.update({
    where: { organizationId_userId: { organizationId: s.organizationId, userId: s.ownerId } },
    data: { role: 'member' },
  })
  assert.equal(await prisma.userAlert.count({
    where: { ...visibleUserAlertWhere({ organizationId: s.organizationId, userId: s.ownerId }), kind: 'trigger_machine_access' },
  }), 0)
  await prisma.organizationMember.update({
    where: { organizationId_userId: { organizationId: s.organizationId, userId: s.ownerId } },
    data: { role: 'owner' },
  })

  // agent_trigger_update may not carry a trigger out of this project.
  assert.equal(
    await refusal(runAgentTriggerUpdateTool(asOwner, { targetChannelId: s.elsewhereId, triggerId: row.id })),
    'targetChannelId: that channel is in another project; from here a trigger works only in this project, '
    + 'in a channel of it the agent is in',
  )
  // Nor change another project's trigger, even from a run the CTO is in there.
  const foreign = await prisma.agentTrigger.create({
    data: { agentId: s.scoutId, config: {}, name: 'Scout manual', targetChannelId: s.elsewhereId, type: 'manual' },
  })
  assert.match(
    await refusal(runAgentTriggerUpdateTool(asOwner, { name: 'Mine now', triggerId: foreign.id })),
    /^agentId: from here you can set up triggers only for yourself/,
  )
})
