// CI smoke test: one full scenario through the real run pipeline against a
// seeded Postgres, with inference served by the deterministic mock provider.
//
//   message → run.execute enqueue → agentic loop → builtin tool call →
//   completion
//
// Asserts the terminal state, the assistant message, the tool-call record,
// the token-ledger events, and the run.timing TaskEvent.
//
// Run: pnpm --filter @nessie/worker test:smoke
// Requires: Postgres at DATABASE_URL (default the local dev container,
// postgresql://nessie:nessie@localhost:55432/nessie) with migrations applied.
import assert from 'node:assert/strict'

process.env.DATABASE_URL ??= 'postgresql://nessie:nessie@localhost:55432/nessie'
process.env.NESSIE_DB_URL ??= process.env.DATABASE_URL
process.env.NESSIE_MODEL_PROVIDER ??= 'openai'
process.env.NESSIE_MODEL_API_KEY ??= 'mock-token'
process.env.OPENAI_API_KEY ??= 'mock-token'

const SCENARIO = 'channel-list-tool'
const EXPECTED_ANSWER =
  'The workspace has a handful of channels, including the one we are talking in right now.'

const main = async (): Promise<void> => {
  // The mock server must exist before worker code is imported: the agent loop
  // captures loadConfig() (incl. NESSIE_MODEL_BASE_URL) at module load.
  const { createMockLlmServer, loadScenario } = await import('@nessie/mock-llm')
  const server = await createMockLlmServer({ scenario: await loadScenario(SCENARIO) })
  process.env.NESSIE_MODEL_BASE_URL = `${server.url}/v1`

  const { cleanupScope, seedRun, seedScope, startMockPipeline } = await import('./pipeline.js')
  const pipeline = await startMockPipeline({ workers: 1 })
  const scope = await seedScope(pipeline.prisma, 'smoke')
  const seeded = await seedRun(
    pipeline.prisma,
    scope,
    'Which channels does this workspace have?',
  )
  const runIds = [seeded.runId]

  try {
    await pipeline.enqueueRun(seeded.payload)
    const terminal = await pipeline.waitForTerminalRuns(runIds, 60_000)

    assert.equal(terminal.get(seeded.runId), 'completed', 'run reaches terminal completed state')

    const run = await pipeline.prisma.run.findUniqueOrThrow({
      select: { finishedAt: true, startedAt: true, status: true },
      where: { id: seeded.runId },
    })
    assert.equal(run.status, 'completed')
    assert.ok(run.startedAt && run.finishedAt, 'run carries start/finish timestamps')

    const assistantMessage = await pipeline.prisma.message.findFirst({
      orderBy: { createdAt: 'desc' },
      where: { agentId: scope.agentId, role: 'assistant', threadId: seeded.threadId },
    })
    assert.equal(assistantMessage?.content, EXPECTED_ANSWER, 'scripted answer is delivered')

    const toolCalls = await pipeline.prisma.toolCall.findMany({
      where: { runId: seeded.runId },
    })
    assert.equal(toolCalls.length, 1, 'exactly one tool call ran')
    assert.equal(toolCalls[0]?.toolName, 'channel_list')
    assert.equal(toolCalls[0]?.success, true)

    const timingEvents = await pipeline.prisma.taskEvent.findMany({
      where: { eventType: 'run.timing', taskId: seeded.taskId },
    })
    assert.equal(timingEvents.length, 1, 'run.timing TaskEvent recorded')
    const timing = timingEvents[0]?.payload as Record<string, unknown>
    assert.equal(timing['outcome'], 'completed')
    assert.equal(timing['runId'], seeded.runId)
    assert.equal(timing['inferenceCount'], 2, 'two scripted inference turns timed')
    assert.equal(timing['toolCount'], 1)

    const ledgerEvents = await pipeline.prisma.tokenLedgerEvent.findMany({
      where: { runId: seeded.runId },
    })
    assert.equal(ledgerEvents.length, 2, 'one ledger event per inference invocation')
    for (const event of ledgerEvents) {
      assert.equal(event.provider, 'openai')
      assert.equal(event.model, 'mock-model')
      assert.equal(event.organizationId, scope.organizationId)
      assert.ok((event.totalTokens ?? 0) > 0, 'ledger event carries token usage')
    }

    const agent = await pipeline.prisma.agent.findUniqueOrThrow({
      select: { status: true },
      where: { id: scope.agentId },
    })
    assert.equal(agent.status, 'idle', 'agent returns to idle')

    const task = await pipeline.prisma.task.findUniqueOrThrow({
      select: { status: true },
      where: { id: seeded.taskId },
    })
    assert.equal(task.status, 'done')

    assert.equal(server.stats().requests, 2, 'mock provider served both scripted turns')

    console.log('[smoke] PASS: message → run → tool call → completion')
    console.log(
      `[smoke] run ${seeded.runId} completed; `
      + `ledger events: ${ledgerEvents.length}, run.timing: inferenceCount=${timing['inferenceCount']} toolCount=${timing['toolCount']}`,
    )
  } finally {
    await cleanupScope(pipeline.prisma, pipeline.pool, scope, runIds)
    await pipeline.stop()
    await server.close()
  }
}

main().catch((error: unknown) => {
  console.error('[smoke] FAIL:', error instanceof Error ? error.message : error)
  process.exit(1)
})
