import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { createConsumedSourceSink } from '../src/run/execute/disclosure-basis.js'
import { runTicketLabelCreateTool, runTicketLabelsReadTool } from '../src/run/pa-tools/ticket-labels.js'
import { ticketProjectIdFor } from '../src/run/pa-tools/ticket-context.js'
import {
  runTicketBoardReadTool,
  runTicketCreateTool,
  runTicketListTool,
} from '../src/run/pa-tools/tickets.js'
import type { BuiltinToolRuntimeContext } from '../src/run/tool-types.js'

// F13: a shared agent lent the board tools in its project channel works on
// that channel's project without being handed its UUID. It holds no
// project_list, so a required projectId (and a hint pointing at project_list)
// left it guessing. The Personal Assistant works across projects and still
// names one.

const contextFor = (
  agentKind: BuiltinToolRuntimeContext['agentKind'],
  projectId: string | null,
): BuiltinToolRuntimeContext => ({
  agentKind,
  channel: { id: randomUUID(), organizationId: randomUUID(), projectId },
}) as unknown as BuiltinToolRuntimeContext

test('an omitted projectId is the channel\'s project for a shared agent, and a named one is kept', () => {
  const channelProject = randomUUID()
  const named = randomUUID()
  assert.equal(ticketProjectIdFor(contextFor('shared', channelProject), undefined), channelProject)
  // A named project passes through; `projectFor` is what refuses another one.
  assert.equal(ticketProjectIdFor(contextFor('shared', channelProject), named), named)
  assert.equal(ticketProjectIdFor(contextFor('personal_assistant', null), named), named)
})

test('with no project to default to, each agent is told what it can actually do', () => {
  assert.throws(
    () => ticketProjectIdFor(contextFor('personal_assistant', null), undefined),
    { message: 'Name the projectId. Resolve it with project_list first.' },
  )
  // The Personal Assistant never defaults, even where a channel has a project.
  assert.throws(
    () => ticketProjectIdFor(contextFor('personal_assistant', randomUUID()), undefined),
    /project_list/,
  )
  assert.throws(
    () => ticketProjectIdFor(contextFor('shared', null), undefined),
    (error: Error) => /not in a project channel/.test(error.message) && !/project_list/.test(error.message),
  )
})

const dbTest = process.env.DATABASE_URL ? test : test.skip

dbTest('a shared agent reads and writes its channel\'s board without naming the project', async () => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const requesterId = randomUUID()
  const outsiderId = randomUUID()
  const projectId = randomUUID()
  const otherProjectId = randomUUID()
  const agentId = randomUUID()
  const channelId = randomUUID()
  const teamId = randomUUID()
  try {
    await prisma.organization.create({ data: { id: organizationId, name: 'Project default org' } })
    await prisma.user.createMany({
      data: [
        { id: requesterId, displayName: 'Requester', email: `${requesterId}@test.local` },
        { id: outsiderId, displayName: 'Outsider', email: `${outsiderId}@test.local` },
      ],
    })
    await prisma.organizationMember.createMany({
      data: [
        { organizationId, role: 'member', userId: requesterId },
        { organizationId, role: 'member', userId: outsiderId },
      ],
    })
    await prisma.project.create({ data: { id: projectId, name: 'Board project', organizationId } })
    await prisma.project.create({ data: { id: otherProjectId, name: 'Other project', organizationId } })
    await prisma.projectMember.create({ data: { projectId, userId: requesterId } })
    await prisma.team.create({ data: { id: teamId, name: 'Project default team', projectId } })
    // Lent ticket_label_create, as the gate requires; without the lend a shared
    // agent's label create is the project-operator arm's, which this is not.
    await prisma.agent.create({ data: { id: agentId, name: 'CTO', organizationId, toolPolicy: { ticket_label_create: true } } })
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

    const contextAs = (userId: string) => ({
      actorContext: {
        actionContext: { requestId: randomUUID() },
        actor: { actorId: userId, actorType: 'user', roles: ['member'] },
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
    }) as unknown as BuiltinToolRuntimeContext
    const context = contextAs(requesterId)

    const boards = await runTicketBoardReadTool(context, {})
    assert.equal(boards.inputSummary, `projectId=${projectId}`)
    assert.match(boards.outputPreview, new RegExp(`boardId=${board.id}`))

    const created = await runTicketCreateTool(context, { title: 'Wire the webhook' })
    assert.equal(created.inputSummary, `projectId=${projectId} title="Wire the webhook"`)
    const ticket = await prisma.task.findFirstOrThrow({ where: { organizationId, title: 'Wire the webhook' } })
    assert.equal(ticket.projectId, projectId)

    const listed = await runTicketListTool(context, {})
    assert.match(listed.outputPreview, new RegExp(`ticketId=${ticket.id}`))

    const label = await runTicketLabelCreateTool(context, { name: 'Bug' })
    assert.match(label.outputPreview, /Created label on board "Board"/)
    const labels = await runTicketLabelsReadTool(context, {})
    assert.match(labels.outputPreview, /- Bug \| labelId=/)

    // Another project is still refused, and the refusal says how to recover.
    await assert.rejects(
      () => runTicketListTool(context, { projectId: otherProjectId }),
      { message: 'This agent may work only on the project that owns this channel. Omit projectId to use it.' },
    )
    // A requester who cannot open the project is told so — not sent to a
    // project_list the agent does not hold.
    await assert.rejects(
      () => runTicketListTool(contextAs(outsiderId), {}),
      (error: Error) => /cannot open this project/.test(error.message) && !/project_list/.test(error.message),
    )
  } finally {
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined)
    await prisma.user.deleteMany({ where: { id: { in: [requesterId, outsiderId] } } }).catch(() => undefined)
    await prisma.$disconnect()
  }
})
