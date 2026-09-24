import assert from 'node:assert/strict'

import { PrismaClient } from '@prisma/client'
import { visibleUserAlertWhere } from '@nessie/db'
import { raiseTriggerMachineAccessAttention } from '@nessie/team-admin'

import { runAgentTriggerUpdateTool } from '../../src/run/pa-tools/agent-lifecycle.js'
import { runTicketBoardCreateTool } from '../../src/run/pa-tools/peer-delegation.js'
import { runAgentTriggerCreateTool, runChannelCreateTool } from '../../src/run/pa-tools/provisioning.js'
import { runProjectStructureReadTool } from '../../src/run/pa-tools/provisioning-structure.js'
import {
  runKbSpaceCreateTool,
  runTicketBoardColumnCreateTool,
  runTicketBoardColumnUpdateTool,
} from '../../src/run/pa-tools/project-operator-tools.js'
import { runProjectCreateTool, runTeamCreateTool } from '../../src/run/pa-tools/team-structure.js'
import { runTicketLabelCreateTool } from '../../src/run/pa-tools/ticket-labels.js'
import {
  runWorkflowCreateTool,
  runWorkflowInstallTool,
  runWorkflowRunTool,
  runWorkflowTriggerCreateTool,
} from '../../src/run/pa-tools/workflow-authoring.js'
import { operatorContext, refusal, seedProjectOperatorWorld } from './project-operator-fixture.js'
import { runDatabaseTest } from './support.js'

/**
 * The project-operator verbs against real rows
 * (docs/plans/2026-09-23-ticket-driven-agents/setup-and-ui.md → "The
 * project-operator capability"; verification.md → "T6"): each acts as the
 * person asking, through the function its route calls, and is refused beyond
 * their rights. The arm's own admission is `project-operator.test.ts`.
 *
 * Cleanup is scoped to this suite's own organisation.
 */

const CANNOT_CHANGE = /cannot change that project/
const GRAPH = { steps: [{ id: 'read', input: { toolName: 'state_get' }, type: 'tool_call' }] }

runDatabaseTest('each operator verb acts as the person asking, and is refused beyond their rights', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedProjectOperatorWorld(prisma)
  t.after(() => s.cleanup().then(() => prisma.$disconnect()))
  const asOwner = () => operatorContext(prisma, s, s.ownerId)
  const asMember = () => operatorContext(prisma, s, s.memberId)
  const asOutsider = () => operatorContext(prisma, s, s.outsiderId)

  // project_create: the member's own project, with them as its only member.
  const created = await runProjectCreateTool(await asMember(), { name: 'Mobile', teamId: s.teamId })
  const mobile = await prisma.project.findFirstOrThrow({
    where: { name: 'Mobile', organizationId: s.organizationId },
    select: { id: true, members: { select: { userId: true } } },
  })
  assert.match(created.outputPreview, new RegExp(`\\[Mobile\\]\\(/projects/${mobile.id}\\)`))
  assert.deepEqual(mobile.members.map((row) => row.userId), [s.memberId])
  assert.match(
    await refusal(runProjectCreateTool(await asOutsider(), { name: 'Nope', teamId: s.teamId })),
    /not allowed to create a project in that team/,
  )
  // team_create is an organisation owner's.
  assert.match(
    await refusal(runTeamCreateTool(await asMember(), { name: 'Squad', projectId: s.projectId })),
    /^Only an organisation owner can create a team/,
  )

  // channel_create: the owner's, protected when nothing was asked for; not in a
  // project the person asking cannot change.
  await runChannelCreateTool(await asOwner(), { label: 'mobile-dev', projectId: s.projectId, teamId: s.teamId })
  const room = await prisma.channel.findFirstOrThrow({
    where: { label: 'mobile-dev', organizationId: s.organizationId },
    select: { members: { select: { userId: true } }, visibility: true },
  })
  assert.equal(room.visibility, 'protected')
  assert.deepEqual(room.members.map((row) => row.userId), [s.ownerId])
  assert.match(
    await refusal(runChannelCreateTool(await asOutsider(), { label: 'intruder', projectId: s.projectId, teamId: s.teamId })),
    /not a member of that project|not allowed/i,
  )
  assert.equal(await prisma.channel.count({ where: { label: 'intruder', organizationId: s.organizationId } }), 0)

  // ticket_board_create reaches a project the person can change — the new one
  // included — and refuses one they cannot.
  const board = await runTicketBoardCreateTool(await asMember(), { name: 'Mobile board', projectId: mobile.id })
  assert.match(board.outputPreview, /^Created board:\n- \[Mobile board\]/)
  assert.match(board.outputPreview, /\n  - In progress \(in_progress\) \| columnId=/)
  assert.match(await refusal(runTicketBoardCreateTool(await asMember(), { name: 'Not mine', projectId: s.otherProjectId })), CANNOT_CHANGE)

  // Columns: any project member, as in Board settings; a non-editor is refused.
  const column = await runTicketBoardColumnCreateTool(await asMember(), { boardId: s.boardId, category: 'review', name: 'QA' })
  const review = await prisma.boardColumn.findFirstOrThrow({ where: { boardId: s.boardId, name: 'QA' } })
  assert.match(column.outputPreview, new RegExp(`^Added column QA \\(review, columnId=${review.id}\\) to \\[Engineering\\]`))
  assert.match(await refusal(runTicketBoardColumnCreateTool(await asOutsider(), {
    boardId: s.boardId, category: 'todo', name: 'Mine',
  })), CANNOT_CHANGE)
  assert.match(await refusal(runTicketBoardColumnUpdateTool(await asOutsider(), {
    boardId: s.boardId, columnId: review.id, name: 'Taken over',
  })), CANNOT_CHANGE)
  await runTicketBoardColumnUpdateTool(await asMember(), {
    boardId: s.boardId, category: 'in_progress', columnId: review.id, name: 'Doing',
  })
  const changed = await prisma.boardColumn.findUniqueOrThrow({ where: { id: review.id } })
  assert.deepEqual([changed.name, changed.category], ['Doing', 'in_progress'])

  // ticket_label_create on the operator arm alone (no lend of its own), and
  // not in a project the person asking cannot change.
  await runTicketLabelCreateTool(await asMember(), { name: 'mobile' })
  assert.equal(await prisma.taskLabel.count({ where: { boardId: s.boardId, name: 'mobile' } }), 1)
  assert.match(await refusal(runTicketLabelCreateTool(await asMember(), { name: 'x', projectId: s.otherProjectId })), CANNOT_CHANGE)

  // kb_space_create: the project's documents space, idempotently, and a named
  // one, each audited as the route audits it; only a member of the project may.
  const docs = await runKbSpaceCreateTool(await asMember(), { kind: 'project_documents' })
  assert.match(docs.outputPreview, /^Created Project Documents of project "Nessie"/)
  assert.match((await runKbSpaceCreateTool(await asMember(), { kind: 'project_documents' })).outputPreview, /^Already there:/)
  await runKbSpaceCreateTool(await asMember(), { kind: 'space', name: 'Tech docs' })
  const tech = await prisma.knowledgeSpace.findFirstOrThrow({ where: { name: 'Tech docs', projectId: s.projectId } })
  assert.equal(tech.visibility, 'project')
  assert.equal(await prisma.auditLog.count({
    where: { action: 'kb.space.created', actorId: s.memberId, organizationId: s.organizationId },
  }), 2)
  assert.match(await refusal(runKbSpaceCreateTool(await asOutsider(), { kind: 'space', name: 'Leak' })), /Only a member of that project/)
  assert.match(await refusal(runKbSpaceCreateTool(await asMember(), {
    kind: 'space', name: 'Leak', projectId: s.otherProjectId,
  })), /Only a member of that project/)

  // Workflows: an owner's; the trigger records who set it up.
  assert.match(
    await refusal(runWorkflowCreateTool(await asMember(), { graph: GRAPH, name: 'x' })),
    /^Only an organisation owner can create a workflow/,
  )
  const workflow = await runWorkflowCreateTool(await asOwner(), { graph: GRAPH, name: 'Nightly check' })
  const workflowTemplateId = /workflowTemplateId=([0-9a-f-]{36})/.exec(workflow.outputPreview)![1]!
  assert.match(
    await refusal(runWorkflowInstallTool(await asMember(), { workflowTemplateId })),
    /^Only an organisation owner can install a workflow/,
  )
  const installed = await runWorkflowInstallTool(await asOwner(), { workflowTemplateId })
  const workflowInstallationId = /workflowInstallationId=([0-9a-f-]{36})/.exec(installed.outputPreview)![1]!
  assert.match(
    await refusal(runWorkflowTriggerCreateTool(await asMember(), { type: 'manual', workflowInstallationId })),
    /^Only an organisation owner can create a workflow trigger/,
  )
  // An installation in no channel is a workflow admin's to run.
  assert.match(
    await refusal(runWorkflowRunTool(await asMember(), { workflowInstallationId })),
    /Workflow installation not found/,
  )
  await runWorkflowTriggerCreateTool(await asOwner(), { type: 'manual', workflowInstallationId })
  const workflowTrigger = await prisma.agentTrigger.findFirstOrThrow({ where: { workflowInstallationId } })
  assert.equal((workflowTrigger.config as Record<string, unknown>)['authorUserId'], s.ownerId)
})

runDatabaseTest('setting up project Mobile shapes the board it starts with, and reads it back', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedProjectOperatorWorld(prisma)
  t.after(() => s.cleanup().then(() => prisma.$disconnect()))

  const created = await runProjectCreateTool(await operatorContext(prisma, s, s.ownerId), { name: 'Mobile', teamId: s.teamId })
  const projectId = /\]\(\/projects\/([0-9a-f-]{36})\)/.exec(created.outputPreview)![1]!
  const boardId = /\(boardId=([0-9a-f-]{36})\) — the default board/.exec(created.outputPreview)![1]!
  const columnId = (name: string) =>
    new RegExp(`\\n  - ${name} \\([a-z_]+\\) \\| columnId=([0-9a-f-]{36})`).exec(created.outputPreview)![1]!
  // Backlog / In progress / Review / Done, out of the board it starts with.
  await runTicketBoardColumnUpdateTool(await operatorContext(prisma, s, s.ownerId), {
    boardId, columnId: columnId('To do'), name: 'Backlog',
  })
  assert.equal(await prisma.board.count({ where: { projectId } }), 1, 'no second board')

  const read = await runProjectStructureReadTool(await operatorContext(prisma, s, s.ownerId), { projectId })
  for (const [name, category] of [['Backlog', 'todo'], ['In progress', 'in_progress'], ['Review', 'review'], ['Done', 'done']]) {
    assert.match(read.outputPreview, new RegExp(`\\n  - ${name} \\(${category}\\) \\| columnId=`), name)
  }
  // As the person asking, and never wider: a project they are not in reads as missing.
  assert.match(
    await refusal(runProjectStructureReadTool(await operatorContext(prisma, s, s.memberId), { projectId })),
    /Project not found, or you are not in it/,
  )
})

runDatabaseTest('a ticket trigger the operator sets up stays in its project and asks for machine access until it exists', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedProjectOperatorWorld(prisma)
  t.after(() => s.cleanup().then(() => prisma.$disconnect()))
  const asOwner = () => operatorContext(prisma, s, s.ownerId)
  const trigger = async (context: Awaited<ReturnType<typeof asOwner>>, agentId: string, targetChannelId: string, column = 'In progress') =>
    runAgentTriggerCreateTool(context, {
      agentId,
      config: { instructions: { general: 'Read the ticket first.' }, pickup: { columns: [{ name: column }] } },
      name: `CTO pickup (${column})`,
      targetChannelId,
      type: 'ticket_changed',
    })
  const visibleItems = () => prisma.userAlert.findMany({
    where: { ...visibleUserAlertWhere({ organizationId: s.organizationId, userId: s.ownerId }), kind: 'trigger_machine_access' },
    select: { actorAgentId: true, projectId: true, triggerId: true },
    orderBy: { createdAt: 'asc' },
  })

  // Only an organisation owner creates a trigger, as on the Triggers page.
  const asMember = await operatorContext(prisma, s, s.memberId)
  assert.match(await refusal(trigger(asMember, s.ctoId, s.engId)), /^Only an organisation owner/)
  // Not itself in a project it is not working in, even where it is bound…
  assert.equal(
    await refusal(trigger(await asOwner(), s.ctoId, s.elsewhereId)),
    'targetChannelId: that channel is in another project; from here a trigger works only in this project, '
    + 'in a channel of it the agent is in',
  )
  // …nor an agent that works only in another project.
  assert.equal(
    await refusal(trigger(await asOwner(), s.scoutId, s.elsewhereId)),
    'agentId: from here you can set up triggers only for yourself or an agent in one of this project\'s channels',
  )

  // Created twice, on two columns: one item for each trigger, for the person asked for.
  const first = await trigger(await asOwner(), s.ctoId, s.engId)
  assert.match(first.outputPreview, /\nMachine access: not set up\. The owner of the machines the work runs on/)
  await trigger(await asOwner(), s.ctoId, s.engId, 'Review')
  const rows = await prisma.agentTrigger.findMany({
    where: { agentId: s.ctoId, type: 'ticket_changed' }, orderBy: { createdAt: 'asc' }, select: { config: true, id: true },
  })
  assert.equal(rows.length, 2)
  for (const row of rows) assert.equal((row.config as Record<string, unknown>)['authorUserId'], s.ownerId)
  assert.deepEqual(
    await visibleItems(),
    rows.map((row) => ({ actorAgentId: s.ctoId, projectId: s.projectId, triggerId: row.id })),
  )
  // Raised again for the same trigger, it is still one item.
  await raiseTriggerMachineAccessAttention(prisma, {
    actorAgentId: s.ctoId,
    organizationId: s.organizationId,
    projectId: s.projectId,
    triggerId: rows[0]!.id,
    userId: s.ownerId,
  })
  assert.equal(await prisma.userAlert.count({ where: { kind: 'trigger_machine_access', triggerId: rows[0]!.id } }), 1)

  // Once the machines' owner sets machine access up — a policy being prepared
  // or live — the item stops surfacing, and it returns if that ends.
  const policy = await prisma.executorStandingPolicy.create({
    data: {
      agentId: s.ctoId, authorUserId: s.ownerId, hostProfile: {}, organizationId: s.organizationId,
      status: 'preparing', triggerDigest: 'digest', triggerId: rows[0]!.id,
    },
  })
  assert.deepEqual((await visibleItems()).map((item) => item.triggerId), [rows[1]!.id])
  await prisma.executorStandingPolicy.update({
    where: { id: policy.id },
    data: { authorOrigin: { organizationId: s.organizationId }, confirmedAt: new Date(), status: 'live' },
  })
  assert.deepEqual((await visibleItems()).map((item) => item.triggerId), [rows[1]!.id])
  await prisma.executorStandingPolicy.update({
    where: { id: policy.id },
    data: { endedAt: new Date(), endedReason: 'person', status: 'ended' },
  })
  assert.equal((await visibleItems()).length, 2)

  // A demoted owner keeps no doorway into it.
  await prisma.organizationMember.update({
    where: { organizationId_userId: { organizationId: s.organizationId, userId: s.ownerId } },
    data: { role: 'member' },
  })
  assert.equal((await visibleItems()).length, 0)
  await prisma.organizationMember.update({
    where: { organizationId_userId: { organizationId: s.organizationId, userId: s.ownerId } },
    data: { role: 'owner' },
  })

  // agent_trigger_update may not carry a trigger out of this project, and says
  // "an agent's", its own included.
  assert.equal(
    await refusal(runAgentTriggerUpdateTool(await asOwner(), {
      targetChannelId: s.elsewhereId, triggerId: rows[0]!.id,
    })),
    'targetChannelId: that channel is in another project; from here a trigger works only in this project, '
    + 'in a channel of it the agent is in',
  )
  assert.match(
    await refusal(runAgentTriggerUpdateTool(await operatorContext(prisma, s, s.memberId), { name: 'x', triggerId: rows[0]!.id })),
    /^Only an organisation owner can update an agent’s trigger/,
  )
  // Nor change another project's trigger, even from a run the CTO is in there.
  const foreign = await prisma.agentTrigger.create({
    data: { agentId: s.scoutId, config: {}, name: 'Scout manual', targetChannelId: s.elsewhereId, type: 'manual' },
  })
  assert.match(
    await refusal(runAgentTriggerUpdateTool(await asOwner(), { name: 'Mine now', triggerId: foreign.id })),
    /^agentId: from here you can set up triggers only for yourself/,
  )
})
