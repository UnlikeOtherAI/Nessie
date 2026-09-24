import assert from 'node:assert/strict'

import type { MockScenario } from '@nessie/mock-llm'
import { RunExecuteJobPayloadSchema } from '@nessie/schemas'

import { runDatabaseTest } from './support.js'

// One `ticket.work` run end to end, through the real run executor with only
// inference pointed at the mock provider (docs/standards/ticket-work.md): a
// board editor's move starts the work, and the run it starts — run setup's
// own admission, not a hand-built tool context — comments on the ticket as
// the agent and answers in the work thread.
//
// Model config must be in place before any worker module loads, so every
// worker import is dynamic and the mock server starts first, as in
// `run-tool-effect-ledger.test.ts`.

process.env['NESSIE_MODEL_PROVIDER'] ??= 'openai'
process.env['NESSIE_MODEL_API_KEY'] ??= 'mock-token'
process.env['OPENAI_API_KEY'] ??= 'mock-token'
process.env['NESSIE_DB_URL'] ??= process.env['DATABASE_URL'] ?? ''

const IDLE = { name: 'ticket-work-idle', turns: [{ latencyMs: 0, text: 'Nothing to do.' }] }

// The scripted conversation is chosen once the ticket exists: its id is in the call.
let scenario: MockScenario | undefined

const startHarness = async () => {
  const { createMockLlmServer, parseScenario } = await import('@nessie/mock-llm')
  const server = await createMockLlmServer({
    scenario: parseScenario(IDLE),
    mainScenarioResolver: () => scenario,
  })
  process.env['NESSIE_MODEL_BASE_URL'] = `${server.url}/v1`
  const harnessModule = await import('../../test-harness/pipeline.js')
  const pipeline = await harnessModule.startMockPipeline({ workers: 0 })
  const runJob = await import('../../src/run/execute.js')
  const fixture = await import('./ticket-work-fixture.js')
  return { parseScenario, pipeline, runJob, fixture, server }
}

runDatabaseTest('a ticket.work run comments on its ticket as the agent and answers in the work thread', async (t) => {
  const harness = await startHarness()
  const { fixture, pipeline } = harness
  const prisma = pipeline.prisma
  const s = await fixture.seedTicketWork(prisma)
  t.after(async () => {
    await s.cleanup()
    await pipeline.stop()
    await harness.server.close()
  })
  const task = await fixture.newTask(prisma, s)
  await fixture.move(prisma, s, task.id, s.columns.inProgress)
  await fixture.drainTicketJobs(prisma, s, new Set())
  const work = await prisma.agentTicketWork.findFirstOrThrow({ where: { triggerId: s.triggerId, taskId: task.id } })
  const run = await prisma.run.findFirstOrThrow({ where: { threadId: work.threadId } })
  const job = await prisma.queueJob.findFirstOrThrow({
    where: { topic: 'run.execute', payload: { path: ['runId'], equals: run.id } },
  })

  scenario = harness.parseScenario({
    name: 'ticket-work-comment',
    turns: [
      {
        latencyMs: 0,
        text: 'Taking a look.',
        toolCalls: [{
          toolCallId: 'ticket-work-comment-1',
          toolName: 'ticket_comment_add',
          arguments: { ticketId: task.id, body: 'Picked up: the redirect drops the path it was given.' },
        }],
      },
      { latencyMs: 0, text: 'I commented on the ticket with what I found.' },
    ],
  })
  await harness.runJob.executeRunJob(
    pipeline.deps,
    RunExecuteJobPayloadSchema.parse(job.payload),
    { attempt: 1, maxAttempts: 3 },
  )

  assert.equal((await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status, 'completed')
  // The comment is the agent's, and the history names the agent and its run.
  const comment = await prisma.taskComment.findFirstOrThrow({ where: { taskId: task.id } })
  assert.deepEqual([comment.authorAgentId, comment.authorUserId], [s.agentId, null])
  assert.equal(comment.body, 'Picked up: the redirect drops the path it was given.')
  const commented = await prisma.taskEvent.findFirstOrThrow({ where: { taskId: task.id, eventType: 'comment_added' } })
  assert.equal((commented.payload as { by?: string }).by, `agent:${s.agentId}`)
  assert.deepEqual((commented.payload as { origin?: unknown }).origin, { kind: 'agent', agentId: s.agentId, runId: run.id })

  // The answer lands in the work thread, as the agent.
  const reply = await prisma.message.findFirstOrThrow({
    where: { threadId: work.threadId, role: 'assistant', agentId: s.agentId },
    orderBy: { createdAt: 'desc' },
  })
  assert.match(reply.content, /I commented on the ticket/)
})
