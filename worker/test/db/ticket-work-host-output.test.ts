import assert from 'node:assert/strict'

import { PrismaClient } from '@prisma/client'

import { TICKET_WORK_HOST_OUTPUT_REFUSAL } from '../../src/run/execute/ticket-work-setup.js'
import { runTicketCommentAddTool } from '../../src/run/pa-tools/ticket-comments.js'
import { executeBuiltinTool } from '../../src/run/tools.js'
import { runDatabaseTest } from './support.js'
import {
  drainTicketJobs,
  finishRuns,
  move,
  newTask,
  seedTicketWork,
  ticketWorkToolContext,
} from './ticket-work-fixture.js'

/**
 * Where a `ticket.work` run may put its machine's output
 * (docs/plans/2026-09-23-ticket-driven-agents/machine-access.md → "Disclosure"):
 * once a local program has answered it — the run is stamped with its work
 * thread's channel as the launch conversation — only its own ticket's
 * comments and its work thread take it. Another ticket's comments, the
 * ticket's own fields and another channel are refused; a move, which carries
 * no text, is not. Before any host output, the run writes as it always could.
 */

runDatabaseTest('a ticket.work run that read its machine\'s output posts it only to its own ticket\'s comments', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const task = await newTask(prisma, s)
  const other = await newTask(prisma, s, { title: 'Another ticket' })
  await move(prisma, s, task.id, s.columns.inProgress)
  await drainTicketJobs(prisma, s, new Set())
  const work = await prisma.agentTicketWork.findFirstOrThrow({ where: { taskId: task.id, triggerId: s.triggerId } })
  await finishRuns(prisma, work.threadId)
  const context = ticketWorkToolContext(prisma, s, work)

  // Nothing from the machine yet: another ticket of the project takes a comment as ever.
  assert.match((await runTicketCommentAddTool(context, { body: 'Noted.', ticketId: other.id })).outputPreview,
    /Added comment/)

  // A coding session answered: the run's basis carries its launch conversation, the work thread's channel.
  context.consumedSources!.addHostOutputScope({ scopeId: s.channelId, scopeType: 'channel' })
  assert.match((await runTicketCommentAddTool(context, {
    body: 'Claude opened the pull request.', ticketId: task.id,
  })).outputPreview, /Added comment/)
  await assert.rejects(runTicketCommentAddTool(context, { body: 'Claude says hi.', ticketId: other.id }),
    new Error(TICKET_WORK_HOST_OUTPUT_REFUSAL))

  // Every other writing tool refuses before it runs: another channel, the ticket's own fields.
  for (const [tool, args] of [
    ['send_message', { channelId: s.channelId, content: 'Claude said…' }],
    ['ticket_update', { detail: 'Claude said…', ticketId: task.id }],
    ['agent_conversation_start', { message: 'Claude said…' }],
  ] as const) {
    const refused = await executeBuiltinTool(tool, { ...args }, context)
    assert.deepEqual([refused.success, refused.output], [false, TICKET_WORK_HOST_OUTPUT_REFUSAL], tool)
  }
  // A move carries no text: the gate lets it through to its own checks.
  const moved = await executeBuiltinTool('ticket_move', { columnId: s.columns.review, ticketId: task.id }, context)
  assert.notEqual(moved.output, TICKET_WORK_HOST_OUTPUT_REFUSAL)
  assert.equal(await prisma.taskComment.count({ where: { taskId: other.id } }), 1, 'the other ticket got nothing more')
})
