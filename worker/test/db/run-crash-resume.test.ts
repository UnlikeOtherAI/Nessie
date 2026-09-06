import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { runDatabaseTest } from './support.js'

// Crash checkpoints and in-place resume, end to end (horizontal scaling, 3.1).
//
// The defect these cover is the whole reason the feature exists: a run whose
// worker dies used to be re-claimed and re-executed FROM THE PROMPT, so every
// tool that had already run ran again and every inference was billed twice.
// Both tests therefore assert two numbers that only a real pipeline produces —
// how many times the mock provider was asked for the run's FIRST turn, and how
// many child agents `spawn_subtask` actually created.
//
// `spawn_subtask` is the probe because its side effect is a row in the world
// (a child Agent, and a queued run for it) rather than bookkeeping about the
// call. It is `safe`, needs no approval, and the child run is never executed
// here — nothing subscribes to the queue — so it cannot pollute the provider
// counts it is being measured against.
//
// Model config must be in place before any worker module loads (`loadConfig()`
// is captured at import time), which is why every worker import below is
// dynamic and the mock server is started first.

process.env['NESSIE_MODEL_PROVIDER'] ??= 'openai'
process.env['NESSIE_MODEL_API_KEY'] ??= 'mock-token'
process.env['OPENAI_API_KEY'] ??= 'mock-token'
process.env['NESSIE_DB_URL'] ??= process.env['DATABASE_URL'] ?? ''
// The drain must not be able to sit through the second inference: with a 1 ms
// grace the loop gives up as soon as the signal fires, whether it is between
// iterations or waiting on the provider.
process.env['NESSIE_RUN_DRAIN_GRACE_MS'] = '1'

const PROBE_TASK = 'crash-resume probe subtask'

const SCENARIO = {
  defaults: { latencyMs: 0, model: 'mock-model' },
  description: 'Turn 0 spawns a subtask; turn 1 answers. Turn 1 is slow on purpose.',
  name: 'crash-resume-subtask',
  turns: [
    {
      latencyMs: 0,
      text: 'Handing the detail off to a sub-agent first.',
      toolCalls: [
        {
          arguments: { role: 'researcher', task: PROBE_TASK },
          toolCallId: 'mock-call-spawn-subtask-1',
          toolName: 'spawn_subtask',
        },
      ],
      usage: { inputTokens: 120, outputTokens: 20 },
    },
    {
      // Long enough that a drain landing anywhere in this call still expires
      // before the provider answers.
      latencyMs: 1_500,
      text: 'The sub-agent is on it; here is the summary so far.',
      usage: { inputTokens: 180, outputTokens: 16 },
    },
  ],
}

type Harness = Awaited<ReturnType<typeof startHarness>>

const startHarness = async () => {
  const { createMockLlmServer, parseScenario } = await import('@nessie/mock-llm')
  const server = await createMockLlmServer({ scenario: parseScenario(SCENARIO) })
  process.env['NESSIE_MODEL_BASE_URL'] = `${server.url}/v1`

  const harnessModule = await import('../../test-harness/pipeline.js')
  const pipeline = await harnessModule.startMockPipeline({ workers: 0 })
  const runJob = await import('../../src/run/execute.js')
  const crashCheckpoint = await import('../../src/run/execute/crash-checkpoint.js')
  const loopResume = await import('../../src/run/loop-resume.js')
  return { crashCheckpoint, harnessModule, loopResume, pipeline, runJob, server }
}

// One server and one pipeline for the file: the first worker import freezes the
// provider URL, so a second server would never be reached. Counts are compared
// as deltas around each test instead.
let harness: Harness | null = null
const useHarness = async (): Promise<Harness> => {
  harness ??= await startHarness()
  return harness
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Wait until the run's crash checkpoint records a tool it actually executed. */
const waitForRecordedTool = async (
  harnessed: Harness,
  runId: string,
  timeoutMs = 30_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await harnessed.crashCheckpoint.loadCrashCheckpoint(
      harnessed.pipeline.prisma,
      runId,
    )
    if (state && Object.keys(state.toolResults).length > 0) return
    await sleep(10)
  }
  throw new Error(`run ${runId} never recorded a tool result in its crash checkpoint`)
}

const childAgentCount = (harnessed: Harness, parentAgentId: string): Promise<number> =>
  harnessed.pipeline.prisma.agent.count({ where: { parentAgentId } })

const turnRequests = (harnessed: Harness, turn: number): number =>
  harnessed.server.stats().turnCounts[turn] ?? 0

const finish = async (
  harnessed: Harness,
  threadId: string,
  scope: Parameters<Harness['harnessModule']['cleanupScope']>[2],
  runIds: string[],
): Promise<void> => {
  // Scoped to the seed's own thread, which also catches the subtask child's
  // queued run and this suite's own per-test topic — `cleanupScope` only knows
  // the run ids it was handed, and a global `LIKE` would match other suites.
  await harnessed.pipeline.pool.query(
    `DELETE FROM queue_jobs WHERE payload->>'threadId' = $1`,
    [threadId],
  )
  await harnessed.harnessModule.cleanupScope(
    harnessed.pipeline.prisma,
    harnessed.pipeline.pool,
    scope,
    runIds,
  )
}

runDatabaseTest('a re-claimed run resumes in place: no repeated inference, no repeated tool', async () => {
  const harnessed = await useHarness()
  const { pipeline } = harnessed
  const scope = await harnessed.harnessModule.seedScope(pipeline.prisma, 'crash-resume')
  const seeded = await harnessed.harnessModule.seedRun(
    pipeline.prisma,
    scope,
    'Delegate the detail and summarise.',
  )
  const turnZeroBefore = turnRequests(harnessed, 0)

  try {
    // Execution 1 — stopped as soon as the tool has really run, which is the
    // state a worker dies in: one tool executed, one inference paid for.
    const abort = new AbortController()
    const stopWhenToolRan = waitForRecordedTool(harnessed, seeded.runId)
      .then(() => abort.abort())
    await assert.rejects(
      () => harnessed.runJob.executeRunJob(
        pipeline.deps,
        seeded.payload,
        { attempt: 1, maxAttempts: 3 },
        { signal: abort.signal },
      ),
      (error: unknown) => error instanceof harnessed.loopResume.RunDrainedError,
    )
    await stopWhenToolRan

    assert.equal(await childAgentCount(harnessed, scope.agentId), 1, 'the tool really ran')

    // Now make it a crash rather than a hand-back: a killed process leaves its
    // token on the row and simply stops answering, and the takeover window is
    // what eventually frees the run.
    await pipeline.pool.query(
      `UPDATE runs
       SET status = 'running', executor_token = $2::uuid,
           executor_heartbeat_at = now() - interval '5 minutes'
       WHERE id = $1::uuid`,
      [seeded.runId, randomUUID()],
    )

    // Execution 2 — a different worker takes the run over and finishes it.
    await harnessed.runJob.executeRunJob(
      pipeline.deps,
      seeded.payload,
      { attempt: 2, maxAttempts: 3 },
    )

    const run = await pipeline.prisma.run.findUniqueOrThrow({
      select: { status: true },
      where: { id: seeded.runId },
    })
    assert.equal(run.status, 'completed')

    assert.equal(
      turnRequests(harnessed, 0) - turnZeroBefore,
      1,
      'the run\'s first inference was paid for once, not once per executor',
    )
    assert.equal(
      await childAgentCount(harnessed, scope.agentId),
      1,
      'the sub-agent was spawned once: the resumed batch read the recorded result',
    )
    assert.equal(
      await pipeline.prisma.runCheckpoint.count({ where: { runId: seeded.runId } }),
      0,
      'the completed run sheds its crash checkpoint',
    )
  } finally {
    await finish(harnessed, seeded.threadId, scope, [seeded.runId])
  }
})

runDatabaseTest('a drain nacks with worker_drain and the next execution resumes', async () => {
  const harnessed = await useHarness()
  const { pipeline } = harnessed
  const scope = await harnessed.harnessModule.seedScope(pipeline.prisma, 'crash-drain')
  const seeded = await harnessed.harnessModule.seedRun(
    pipeline.prisma,
    scope,
    'Delegate the detail and summarise.',
  )
  const turnZeroBefore = turnRequests(harnessed, 0)

  try {
    // The real `PgQueueProvider` claim/settle machinery, so the nack is the
    // queue's own — but on a topic of this test's own, never `run.execute`.
    // A subscriber claims the globally oldest job on its topic, so a shared
    // database would hand this suite somebody else's run to settle.
    const topic = `run.execute.crash-drain.${randomUUID()}`
    const { enqueueQueueJob } = await import('@nessie/db')
    await enqueueQueueJob(pipeline.prisma, { payload: seeded.payload, topic })
    const abort = new AbortController()
    const subscription = pipeline.queueProvider.subscribe(
      topic,
      async (job, { signal }) => {
        const { RunExecuteJobPayloadSchema } = await import('@nessie/schemas')
        await harnessed.runJob.executeRunJob(
          pipeline.deps,
          RunExecuteJobPayloadSchema.parse(job.payload),
          { attempt: job.attempt, maxAttempts: job.maxAttempts },
          { signal },
        )
      },
      { pollIntervalMs: 25, signal: abort.signal },
    )
    await waitForRecordedTool(harnessed, seeded.runId)
    abort.abort()
    await subscription.done

    const job = await pipeline.pool.query<{ error_message: string; status: string }>(
      'SELECT error_message, status FROM queue_jobs WHERE topic = $1',
      [topic],
    )
    assert.equal(job.rows[0]?.status, 'pending', 'the job is re-claimable at once')
    assert.equal(
      job.rows[0]?.error_message,
      harnessed.loopResume.WORKER_DRAIN_NACK_REASON,
      'and says why it moved',
    )

    const drained = await pipeline.prisma.run.findUniqueOrThrow({
      select: { executorHeartbeatAt: true, executorToken: true, status: true },
      where: { id: seeded.runId },
    })
    assert.equal(drained.status, 'running', 'a drain never fails the run')
    assert.equal(drained.executorToken, null, 'the claim is handed back, not left to expire')
    assert.equal(drained.executorHeartbeatAt, null)

    const state = await harnessed.crashCheckpoint.loadCrashCheckpoint(
      pipeline.prisma,
      seeded.runId,
    )
    assert.notEqual(state, null, 'the checkpoint the successor resumes from is durable')
    assert.ok((state?.iterations ?? 0) >= 1)

    // The successor.
    await harnessed.runJob.executeRunJob(
      pipeline.deps,
      seeded.payload,
      { attempt: 2, maxAttempts: 3 },
    )

    assert.equal(
      (await pipeline.prisma.run.findUniqueOrThrow({
        select: { status: true },
        where: { id: seeded.runId },
      })).status,
      'completed',
    )
    assert.equal(turnRequests(harnessed, 0) - turnZeroBefore, 1)
    assert.equal(await childAgentCount(harnessed, scope.agentId), 1)
  } finally {
    await finish(harnessed, seeded.threadId, scope, [seeded.runId])
  }
})

runDatabaseTest('harness teardown', async () => {
  if (!harness) return
  await harness.pipeline.stop()
  await harness.server.close()
  harness = null
})
