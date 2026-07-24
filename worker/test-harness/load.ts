// Load mode: N concurrent scripted runs through the real queue and run
// pipeline against the mock provider, to expose queue-claim and row-lock
// contention without token spend.
//
//   pnpm --filter @nessie/worker test:load -- --runs 25 --workers 4
//
// Flags: --runs N (default 25), --workers W (default 4 independent queue
// subscribers), --scenario NAME (default channel-list-tool),
// --timeout MS (default 120000). Exits non-zero if any run does not complete.
import { parseArgs } from 'node:util'

process.env.DATABASE_URL ??= 'postgresql://nessie:nessie@localhost:55432/nessie'
process.env.NESSIE_DB_URL ??= process.env.DATABASE_URL
process.env.NESSIE_MODEL_PROVIDER ??= 'openai'
process.env.NESSIE_MODEL_API_KEY ??= 'mock-token'
process.env.OPENAI_API_KEY ??= 'mock-token'

type TimingPayload = {
  inferenceCount: number
  inferenceMs: number
  queueWaitMs: number
  toolCount: number
  toolMs: number
  totalMs: number
}

const percentile = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0

const summarize = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const avg = values.reduce((sum, value) => sum + value, 0) / (values.length || 1)
  return {
    avg: Math.round(avg),
    max: sorted.at(-1) ?? 0,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
  }
}

const main = async (): Promise<void> => {
  const { values: args } = parseArgs({
    options: {
      runs: { default: '25', type: 'string' },
      scenario: { default: 'channel-list-tool', type: 'string' },
      timeout: { default: '120000', type: 'string' },
      workers: { default: '4', type: 'string' },
    },
  })
  const runCount = Number.parseInt(args.runs ?? '25', 10)
  const workers = Number.parseInt(args.workers ?? '4', 10)
  const timeoutMs = Number.parseInt(args.timeout ?? '120000', 10)
  const scenarioName = args.scenario ?? 'channel-list-tool'

  const { createMockLlmServer, loadScenario } = await import('@nessie/mock-llm')
  const server = await createMockLlmServer({ scenario: await loadScenario(scenarioName) })
  process.env.NESSIE_MODEL_BASE_URL = `${server.url}/v1`

  const { cleanupScope, seedRun, seedScope, startMockPipeline } = await import('./pipeline.js')
  const pipeline = await startMockPipeline({ workers })
  const scope = await seedScope(pipeline.prisma, 'load')
  const seeded = await Promise.all(
    Array.from({ length: runCount }, (_, index) =>
      seedRun(pipeline.prisma, scope, `Load run ${index + 1}: which channels exist?`)),
  )
  const runIds = seeded.map((entry) => entry.runId)

  try {
    const startedAt = Date.now()
    await Promise.all(seeded.map((entry) => pipeline.enqueueRun(entry.payload)))
    const terminal = await pipeline.waitForTerminalRuns(runIds, timeoutMs)
    const wallMs = Date.now() - startedAt

    const failures = [...terminal.entries()].filter(([, status]) => status !== 'completed')
    const timingEvents = await pipeline.prisma.taskEvent.findMany({
      select: { payload: true },
      where: { eventType: 'run.timing', taskId: { in: seeded.map((entry) => entry.taskId) } },
    })
    const timings = timingEvents.map((event) => event.payload as unknown as TimingPayload)

    const report = {
      completed: terminal.size - failures.length,
      failed: failures.length,
      inferenceMs: summarize(timings.map((timing) => timing.inferenceMs)),
      queueWaitMs: summarize(timings.map((timing) => timing.queueWaitMs)),
      runs: runCount,
      scenario: scenarioName,
      throughputPerSecond: Math.round((terminal.size / wallMs) * 100_000) / 100,
      totalMs: summarize(timings.map((timing) => timing.totalMs)),
      toolMs: summarize(timings.map((timing) => timing.toolMs)),
      wallMs,
      workers,
    }

    console.log('[load] results')
    console.log(JSON.stringify(report, null, 2))
    if (failures.length > 0) {
      console.error(
        `[load] FAIL: ${failures.length}/${runCount} runs did not complete: `
        + failures.map(([runId, status]) => `${runId}=${status}`).join(', '),
      )
      process.exitCode = 1
    } else {
      console.log(
        `[load] PASS: ${report.completed}/${runCount} runs completed in ${wallMs}ms `
        + `(${report.throughputPerSecond} runs/s, ${workers} workers)`,
      )
    }
  } finally {
    await cleanupScope(pipeline.prisma, pipeline.pool, scope, runIds)
    await pipeline.stop()
    await server.close()
  }
}

main().catch((error: unknown) => {
  console.error('[load] FAIL:', error instanceof Error ? error.message : error)
  process.exit(1)
})
