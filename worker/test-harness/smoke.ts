// CI smoke test: one full scenario through the real run pipeline against a
// seeded Postgres, with inference served by the deterministic mock provider.
//
//   message → run.execute enqueue → agentic loop → builtin tool call →
//   completion
//
// Asserts the terminal state, the assistant message, the tool-call record,
// the token-ledger events, the run.timing TaskEvent, the resolved reply
// anchor, and the durable thought log (reasoning + tool chunks, in order).
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

// Same tool call and answer as `channel-list-tool`, with scripted visible
// reasoning on both turns so the run's thought log is exercised too.
const SCENARIO = 'reasoning-tool-answer'
const EXPECTED_ANSWER =
  'The team has a handful of channels, including the one we are talking in right now.'

// Bounded poll for state a run writes after its status flips terminal.
// Returns the last value seen when the deadline passes, so the caller's own
// assertion reports the mismatch rather than a generic timeout.
const pollFor = async <T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (done(value) || Date.now() >= deadline) {
      return value
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

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
    'Which channels does this team have?',
  )
  const runIds = [seeded.runId]

  try {
    await pipeline.enqueueRun(seeded.payload)
    const terminal = await pipeline.waitForTerminalRuns(runIds, 60_000)

    assert.equal(terminal.get(seeded.runId), 'completed', 'run reaches terminal completed state')

    const run = await pipeline.prisma.run.findUniqueOrThrow({
      select: {
        finishedAt: true,
        replyPlacement: true,
        replyRootMessageId: true,
        startedAt: true,
        status: true,
      },
      where: { id: seeded.runId },
    })
    assert.equal(run.status, 'completed')
    assert.ok(run.startedAt && run.finishedAt, 'run carries start/finish timestamps')
    // No placement judgement on a directly-enqueued run → the #233 default:
    // the reply threads under its top-level trigger message, and the resolved
    // anchor is persisted for REST readers.
    assert.equal(run.replyPlacement, null)
    assert.equal(run.replyRootMessageId, seeded.messageId, 'resolved reply anchor persisted')

    const assistantMessage = await pipeline.prisma.message.findFirst({
      orderBy: { createdAt: 'desc' },
      where: { agentId: scope.agentId, role: 'assistant', threadId: seeded.threadId },
    })
    assert.equal(assistantMessage?.content, EXPECTED_ANSWER, 'scripted answer is delivered')
    assert.equal(assistantMessage?.rootMessageId, seeded.messageId, 'answer lands in the thread')

    const thinking = await pipeline.prisma.runThinkingChunk.findMany({
      orderBy: { id: 'asc' },
      where: { runId: seeded.runId },
    })
    assert.ok(thinking.length >= 3, 'thought log captured reasoning and tool activity')
    assert.ok(
      thinking.some((chunk) => chunk.kind === 'reasoning'),
      'reasoning chunks persisted',
    )
    const toolChunks = thinking.filter((chunk) => chunk.kind === 'tool')
    assert.equal(toolChunks.length, 1, 'one tool line per tool call')
    assert.match(toolChunks[0]?.content ?? '', /^channel_list/)
    // Ordering is the log: the reasoning that led to the call precedes it.
    assert.equal(thinking[0]?.kind, 'reasoning')
    assert.ok(
      thinking.findIndex((chunk) => chunk.kind === 'tool')
      < thinking.map((chunk) => chunk.kind).lastIndexOf('reasoning'),
      'post-tool reasoning is recorded after the tool line',
    )

    const toolCalls = await pipeline.prisma.toolCall.findMany({
      where: { runId: seeded.runId },
    })
    assert.equal(toolCalls.length, 1, 'exactly one tool call ran')
    assert.equal(toolCalls[0]?.toolName, 'channel_list')
    assert.equal(toolCalls[0]?.success, true)

    // `run.timing` is written in executeRunJob's `finally`, deliberately AFTER
    // the run row reaches a terminal status — a telemetry write must never be
    // able to fail a finished run. Waiting on the status alone therefore races
    // the event, which is what made this assertion fail intermittently in CI
    // (`0 !== 1`). Poll for it: its arrival is what marks teardown complete.
    // On timeout the poll returns what it has, so a genuine regression still
    // fails on the assertion below rather than hiding behind a timeout error.
    const timingEvents = await pollFor(
      () => pipeline.prisma.taskEvent.findMany({
        where: { eventType: 'run.timing', taskId: seeded.taskId },
      }),
      (events) => events.length > 0,
    )
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
      + `ledger events: ${ledgerEvents.length}, run.timing: inferenceCount=${timing['inferenceCount']} toolCount=${timing['toolCount']}, `
      + `thinking chunks: ${thinking.length}`,
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
