import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { BUILTIN_TOOL_DEFINITIONS } from '@nessie/runtime'
import { TICKET_WORK_PURPOSE } from '@nessie/schemas'

import { createConsumedSourceSink } from '../src/run/execute/disclosure-basis.js'
import {
  isProjectDelegatedRun,
  PEER_PROJECT_TOOL_IDS,
  resolveProjectDelegatedToolIds,
  resolveWithheldRunToolIds,
} from '../src/run/execute/run-setup.js'
import { TICKET_WORK_PROJECT_TOOL_IDS, ticketWorkToolRefusal } from '../src/run/execute/ticket-work-setup.js'
import {
  relativeTime,
  removedText,
  runTicketAttachmentListTool,
  runTicketAttachmentRemoveTool,
} from '../src/run/pa-tools/ticket-attachments.js'
import { runTicketCommentAddTool, runTicketCommentListTool } from '../src/run/pa-tools/ticket-comments.js'
import { runTicketLabelCreateTool, runTicketLabelsReadTool } from '../src/run/pa-tools/ticket-labels.js'
import { runTicketReadTool, runTicketUpdateTool, TICKET_ACTIVITY_TOOL_RUNNERS } from '../src/run/pa-tools/tickets.js'
import type { BuiltinToolRuntimeContext } from '../src/run/tool-types.js'
import { authorizeToolCall } from '../src/run/tool-policy.js'

// A ticket's comments, labels and files for the Personal Assistant and for a
// shared agent lent project tools in its project channel. Pinned here: which
// tools the peer subset admits and where, that a shared agent's comment is
// authored by the agent while the ticket history names the person who asked,
// and that reading comments into a run stamps the project basis.

const NEW_TOOL_IDS = [
  'ticket_labels_read',
  'ticket_label_create',
  'ticket_comment_list',
  'ticket_comment_add',
  'ticket_comment_update',
  'ticket_comment_delete',
  'ticket_attachment_list',
  'ticket_attachment_add',
  'ticket_attachment_remove',
]
const PA_ONLY = ['ticket_comment_update', 'ticket_comment_delete', 'ticket_attachment_remove']

test('every new ticket builtin is a projects tool with a runner', () => {
  for (const id of NEW_TOOL_IDS) {
    const definition = BUILTIN_TOOL_DEFINITIONS.find((tool) => tool.id === id)
    assert.ok(definition, `${id} is not defined`)
    assert.equal(definition.category, 'projects')
    assert.equal(definition.personalAssistantOnly, true)
    assert.equal(definition.projectDelegatedOnly === true, !PA_ONLY.includes(id), `${id} delegation flag`)
    assert.equal(PEER_PROJECT_TOOL_IDS.has(id), !PA_ONLY.includes(id), `${id} peer membership`)
    assert.ok(Object.hasOwn(TICKET_ACTIVITY_TOOL_RUNNERS, id), `${id} has no dispatcher entry`)
  }
})

test('the peer subset admits ticket_comment_add in a project channel and refuses it elsewhere', () => {
  // The agent's policy grants everything; admission is still the run's to decide.
  const policy = Object.fromEntries(NEW_TOOL_IDS.map((id) => [id, true]))
  const inProject = resolveProjectDelegatedToolIds(isProjectDelegatedRun({
    agentKind: 'shared',
    channelProjectId: randomUUID(),
    actorType: 'user',
    interactive: true,
  }), policy)
  const elsewhere = resolveProjectDelegatedToolIds(isProjectDelegatedRun({
    agentKind: 'shared',
    channelProjectId: null,
    actorType: 'user',
    interactive: true,
  }), policy)

  assert.ok(inProject.has('ticket_comment_add'))
  // Author-only edits and removals stay with the Personal Assistant in v1.
  for (const id of PA_ONLY) assert.equal(inProject.has(id), false, `${id} must not be lent`)
  assert.equal(elsewhere.size, 0)

  const definitions = BUILTIN_TOOL_DEFINITIONS
  const enabled = new Set(NEW_TOOL_IDS)
  assert.deepEqual(
    authorizeToolCall('ticket_comment_add', enabled, definitions, policy, null, 'shared', {
      projectDelegatedToolIds: inProject,
    }),
    { allowed: true },
  )
  assert.deepEqual(
    authorizeToolCall('ticket_comment_add', enabled, definitions, policy, null, 'shared', {
      projectDelegatedToolIds: elsewhere,
    }),
    { allowed: false, reason: 'personal_assistant_only' },
  )
  // An unattended run in a project channel is not a delegation either.
  assert.equal(isProjectDelegatedRun({
    agentKind: 'shared',
    channelProjectId: randomUUID(),
    actorType: 'agent',
    interactive: false,
  }), false)
})

test('a ticket.work run is lent only its agent-capable ticket tools, and only through its own arm', () => {
  const projectId = randomUUID()
  const policy = Object.fromEntries([...PEER_PROJECT_TOOL_IDS].map((id) => [id, true]))
  // It acts as the agent with no person behind it, so a person-looking actor
  // context changes nothing: only its own arm decides, and that arm asks
  // whether the work record it serves belongs to this channel's project.
  for (const actorType of ['user', 'agent']) {
    for (const interactive of [true, false]) {
      const run = { agentKind: 'shared', channelProjectId: projectId, actorType, interactive, purpose: TICKET_WORK_PURPOSE }
      const label = `${actorType}, interactive ${interactive}`
      assert.equal(isProjectDelegatedRun({ ...run, ticketWorkProjectId: projectId }), true, label)
      assert.equal(isProjectDelegatedRun(run), false, `${label}: no work record, no tools`)
      assert.equal(isProjectDelegatedRun({ ...run, ticketWorkProjectId: randomUUID() }), false, `${label}: another project`)
      assert.equal(
        isProjectDelegatedRun({ ...run, agentKind: 'personal_assistant', ticketWorkProjectId: projectId }),
        false,
        `${label}: not a shared agent`,
      )
    }
  }
  const lent = resolveProjectDelegatedToolIds(true, policy, true)
  assert.deepEqual([...lent].sort(), [...TICKET_WORK_PROJECT_TOOL_IDS].sort())
  for (const id of [
    'ticket_create', 'ticket_assign', 'ticket_board_create', 'ticket_label_create',
    'ticket_checklist_apply', 'ticket_checklist_step_update', 'ticket_attachment_add',
  ]) {
    assert.equal(lent.has(id), false, `${id} needs a person`)
  }
  // The agent's policy still decides each one.
  assert.deepEqual([...resolveProjectDelegatedToolIds(true, { ticket_read: true }, true)], ['ticket_read'])
})

test('a ticket.work run withholds and refuses the tools that act for a person', () => {
  const withheld = resolveWithheldRunToolIds({ isHandoffTurn: false, todosEnabled: true, ticketWork: true })
  for (const id of ['schedule_task', 'mailbox_search', 'mailbox_send', 'gmail_search', 'calendar_event_create', 'email_send']) {
    assert.ok(withheld.has(id), id)
  }
  assert.equal(resolveWithheldRunToolIds({ isHandoffTurn: false, todosEnabled: true }).has('schedule_task'), false)
  const ticketWork = { actionContext: { purpose: TICKET_WORK_PURPOSE, requestId: randomUUID() } }
  assert.match(ticketWorkToolRefusal('schedule_task', ticketWork) ?? '', /acts for a person/)
  assert.equal(ticketWorkToolRefusal('ticket_read', ticketWork), null)
  assert.equal(ticketWorkToolRefusal('schedule_task', { actionContext: { requestId: randomUUID() } }), null)
})

test('a removed file\'s line names who removed it, when, and why', () => {
  const now = new Date('2026-09-21T12:00:00Z')
  assert.equal(relativeTime('2026-09-21T11:59:30Z', now), 'just now')
  assert.equal(relativeTime('2026-09-21T10:00:00Z', now), '2 hours ago')
  assert.equal(relativeTime('2026-09-20T12:00:00Z', now), '1 day ago')
  const userId = randomUUID()
  const agentId = randomUUID()
  assert.equal(
    removedText({ at: '2026-09-21T10:00:00Z', byUserId: userId as never, byAgentId: null, reason: 'Superseded by v2' }, now),
    ` REMOVED 2 hours ago by person userId=${userId} — "Superseded by v2"`,
  )
  assert.equal(
    removedText({ at: '2026-09-21T11:00:00Z', byUserId: null, byAgentId: agentId as never, reason: null }, now),
    ` REMOVED 1 hour ago by agent agentId=${agentId}`,
  )
})

const dbTest = process.env.DATABASE_URL ? test : test.skip

dbTest('a shared agent comments as itself for the person who asked, and reading comments stamps the project', async () => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const requesterId = randomUUID()
  const projectId = randomUUID()
  const agentId = randomUUID()
  const channelId = randomUUID()
  const teamId = randomUUID()
  const published: Array<{ event: string; data: Record<string, unknown> }> = []
  try {
    await prisma.organization.create({ data: { id: organizationId, name: 'Ticket activity org' } })
    await prisma.user.create({
      data: { id: requesterId, displayName: 'Requester', email: `${requesterId}@test.local` },
    })
    // A member, not an owner: an owner's reads are not stamped, a member's are.
    await prisma.organizationMember.create({ data: { organizationId, role: 'member', userId: requesterId } })
    await prisma.project.create({ data: { id: projectId, name: 'Ticket activity project', organizationId } })
    await prisma.projectMember.create({ data: { projectId, userId: requesterId } })
    await prisma.team.create({ data: { id: teamId, name: 'Ticket activity team', projectId } })
    await prisma.agent.create({ data: { id: agentId, name: 'Builder', organizationId } })
    await prisma.channel.create({
      data: {
        id: channelId,
        label: 'project room',
        slug: `room-${randomUUID()}`,
        organization: { connect: { id: organizationId } },
        project: { connect: { id: projectId } },
        team: { connect: { id: teamId } },
      },
    })
    await prisma.agentBinding.create({ data: { agentId, channelId } })
    const ticket = await prisma.task.create({
      data: { organizationId, projectId, title: 'Wire the webhook', ownerUserId: requesterId },
    })

    const consumedSources = createConsumedSourceSink()
    const context = {
      actorContext: {
        actionContext: { requestId: randomUUID() },
        actor: { actorId: requesterId, actorType: 'user', roles: ['member'] },
        tenant: { organizationId },
      },
      agentId,
      agentKind: 'shared',
      channel: { id: channelId, organizationId, projectId },
      consumedSources,
      ledgerIdentity: null,
      prisma,
      realtimeTransport: {
        publishWs: async (_scopes: unknown, input: { event: string; data: Record<string, unknown> }) => {
          published.push({ event: input.event, data: input.data })
        },
      },
      run: { id: randomUUID(), interactive: true, messageId: randomUUID(), threadId: randomUUID() },
      toolCallId: randomUUID(),
    } as unknown as BuiltinToolRuntimeContext

    const added = await runTicketCommentAddTool(context, { ticketId: ticket.id, body: 'Webhook is **wired**.' })
    assert.match(added.outputPreview, /Added comment/)

    const comment = await prisma.taskComment.findFirstOrThrow({ where: { taskId: ticket.id } })
    assert.equal(comment.authorAgentId, agentId, 'the agent wrote it')
    assert.equal(comment.authorUserId, null, 'not the person it acted for')
    const event = await prisma.taskEvent.findFirstOrThrow({ where: { taskId: ticket.id, eventType: 'comment_added' } })
    const payload = event.payload as { by?: string; agentId?: string; commentId?: string }
    assert.equal(payload.by, requesterId, 'the history names the person who asked')
    assert.equal(payload.agentId, agentId)
    assert.equal(payload.commentId, comment.id)
    assert.ok(
      published.some((entry) => entry.event === 'task.activity' && entry.data.taskId === ticket.id),
      'an open ticket dialog must hear about the agent\'s comment',
    )

    assert.deepEqual(consumedSources.list(), [], 'nothing was read into the run yet')
    const listed = await runTicketCommentListTool(context, { ticketId: ticket.id })
    assert.match(listed.outputPreview, new RegExp(`agent agentId=${agentId}`))
    assert.match(listed.outputPreview, /Webhook is \*\*wired\*\*\./)
    assert.deepEqual(consumedSources.list(), [{ scopeId: projectId, scopeType: 'project' }])
  } finally {
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined)
    await prisma.user.delete({ where: { id: requesterId } }).catch(() => undefined)
    await prisma.$disconnect()
  }
})

dbTest('board labels and file removal through the ticket tools', async () => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const requesterId = randomUUID()
  const projectId = randomUUID()
  const agentId = randomUUID()
  const channelId = randomUUID()
  const teamId = randomUUID()
  try {
    await prisma.organization.create({ data: { id: organizationId, name: 'Ticket labels org' } })
    await prisma.user.create({
      data: { id: requesterId, displayName: 'Requester', email: `${requesterId}@test.local` },
    })
    await prisma.organizationMember.create({ data: { organizationId, role: 'member', userId: requesterId } })
    await prisma.project.create({ data: { id: projectId, name: 'Ticket labels project', organizationId } })
    await prisma.projectMember.create({ data: { projectId, userId: requesterId } })
    await prisma.team.create({ data: { id: teamId, name: 'Ticket labels team', projectId } })
    await prisma.agent.create({ data: { id: agentId, name: 'Builder', organizationId } })
    await prisma.channel.create({
      data: {
        id: channelId,
        label: 'project room',
        slug: `room-${randomUUID()}`,
        organization: { connect: { id: organizationId } },
        project: { connect: { id: projectId } },
        team: { connect: { id: teamId } },
      },
    })
    await prisma.agentBinding.create({ data: { agentId, channelId } })
    const board = await prisma.board.create({
      data: { projectId, organizationId, name: 'Board', isDefault: true, position: 0 },
    })
    const dev = await prisma.board.create({ data: { projectId, organizationId, name: 'Dev', position: 1 } })
    const ticket = await prisma.task.create({
      data: { organizationId, projectId, title: 'Label me', ownerUserId: requesterId },
    })

    const context = {
      actorContext: {
        actionContext: { requestId: randomUUID() },
        actor: { actorId: requesterId, actorType: 'user', roles: ['member'] },
        tenant: { organizationId },
      },
      agentId,
      agentKind: 'shared',
      channel: { id: channelId, organizationId, projectId },
      consumedSources: createConsumedSourceSink(),
      ledgerIdentity: null,
      prisma,
      realtimeTransport: { publishWs: async () => undefined },
      run: { id: randomUUID(), interactive: true, messageId: randomUUID(), threadId: randomUUID() },
      toolCallId: randomUUID(),
    } as unknown as BuiltinToolRuntimeContext

    // boardId reaches the create; absent means the default board.
    const onDev = await runTicketLabelCreateTool(context, { projectId, boardId: dev.id, name: 'Bug' })
    assert.match(onDev.outputPreview, /Created label on board "Dev"/)
    const onDefault = await runTicketLabelCreateTool(context, { projectId, name: 'Bug' })
    assert.match(onDefault.outputPreview, /Created label on board "Board"/)
    const [devLabel, defaultLabel] = await Promise.all([
      prisma.taskLabel.findFirstOrThrow({ where: { boardId: dev.id } }),
      prisma.taskLabel.findFirstOrThrow({ where: { boardId: board.id } }),
    ])

    const everyBoard = await runTicketLabelsReadTool(context, { projectId })
    assert.match(everyBoard.outputPreview, new RegExp(`Board "Board" boardId=${board.id}\\n- Bug \\| labelId=${defaultLabel.id} boardId=${board.id}`))
    assert.match(everyBoard.outputPreview, new RegExp(`Board "Dev" boardId=${dev.id}\\n- Bug \\| labelId=${devLabel.id} boardId=${dev.id}`))
    const devOnly = await runTicketLabelsReadTool(context, { projectId, boardId: dev.id })
    assert.match(devOnly.outputPreview, new RegExp(`labelId=${devLabel.id}`))
    assert.doesNotMatch(devOnly.outputPreview, new RegExp(`labelId=${defaultLabel.id}`))

    // The ticket is on the default board, so Dev's label is refused in words.
    await assert.rejects(
      () => runTicketUpdateTool(context, { ticketId: ticket.id, labelIds: [devLabel.id] }),
      { message: 'That label is not on this ticket\'s board. Read them with ticket_labels_read.' },
    )
    await runTicketUpdateTool(context, { ticketId: ticket.id, labelIds: [defaultLabel.id] })
    const read = await runTicketReadTool(context, { ticketId: ticket.id })
    assert.match(read.outputPreview, new RegExp(`Labels \\(the project's default board\\): Bug \\(labelId=${defaultLabel.id}\\)`))

    // Removing a file marks it; the shared agent's person and the agent are both recorded.
    const file = await prisma.attachment.create({
      data: {
        organizationId,
        uploaderId: requesterId,
        taskId: ticket.id,
        kind: 'document',
        mime: 'text/plain',
        filename: 'draft.txt',
        sizeBytes: BigInt(5),
        storageKey: `test/${randomUUID()}`,
      },
    })
    const removed = await runTicketAttachmentRemoveTool(context, {
      ticketId: ticket.id,
      attachmentId: file.id,
      reason: 'Superseded by v2',
    })
    assert.equal(
      removed.outputPreview,
      'Marked draft.txt as removed. It stays downloadable; the ticket shows who removed it and why.',
    )
    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: file.id } })
    assert.ok(row.removedAt)
    assert.equal(row.removedByUserId, requesterId)
    assert.equal(row.removedByAgentId, agentId)
    assert.equal(row.removedReason, 'Superseded by v2')

    const listed = await runTicketAttachmentListTool(context, { ticketId: ticket.id })
    assert.match(listed.outputPreview, /^Files \(0\) \(1 removed\)\n/)
    assert.match(
      listed.outputPreview,
      new RegExp(`draft\\.txt .* REMOVED just now by person userId=${requesterId} — "Superseded by v2"$`),
    )
    await assert.rejects(
      () => runTicketAttachmentRemoveTool(context, { ticketId: ticket.id, attachmentId: file.id }),
      { message: 'That file is already marked as removed.' },
    )
  } finally {
    await prisma.attachment.deleteMany({ where: { organizationId } }).catch(() => undefined)
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined)
    await prisma.user.delete({ where: { id: requesterId } }).catch(() => undefined)
    await prisma.$disconnect()
  }
})
