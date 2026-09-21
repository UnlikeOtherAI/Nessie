import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { BUILTIN_TOOL_DEFINITIONS } from '@nessie/runtime'

import { createConsumedSourceSink } from '../src/run/execute/disclosure-basis.js'
import {
  isProjectDelegatedRun,
  PEER_PROJECT_TOOL_IDS,
  resolveProjectDelegatedToolIds,
} from '../src/run/execute/run-setup.js'
import { runTicketCommentAddTool, runTicketCommentListTool } from '../src/run/pa-tools/ticket-comments.js'
import { TICKET_ACTIVITY_TOOL_RUNNERS } from '../src/run/pa-tools/tickets.js'
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
