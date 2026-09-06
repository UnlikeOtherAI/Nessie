import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { runDatabaseTest } from './support.js'

// The tool-effect ledger (horizontal scaling, 3.2).
//
// The defect: the crash checkpoint records a tool's result AFTER the tool
// returns, so a worker that dies between a side effect committing at the
// provider and its record committing in Postgres leaves no trace of a call that
// really happened — and the resumed run makes it again. `run_tool_effects`
// carries the intent BEFORE the dispatch, so a resume can tell "this may
// already have happened" from "this never started".
//
// `schedule_task` is the probe. It is not `safe`, its category (`scheduling`)
// is one whose effects leave the agent's workspace, it needs no approval and no
// connected account, and its side effect is a row in the world — an
// `AgentTrigger` — rather than bookkeeping about the call. Nothing here ever
// fires the schedule (no scheduler runs in this harness), so the trigger count
// is a clean measure of how many times the tool really executed.
//
// `channel_find` rides along in the same batch as the read-only control. It is
// deliberately a tool from an *effectful* category that is nevertheless `safe`,
// so it proves the scope rule is `!safe AND effectful category` rather than
// category alone: the ledger must leave no row for it.
//
// Model config must be in place before any worker module loads (`loadConfig()`
// is captured at import time), which is why every worker import below is
// dynamic and the mock server is started first.

process.env['NESSIE_MODEL_PROVIDER'] ??= 'openai'
process.env['NESSIE_MODEL_API_KEY'] ??= 'mock-token'
process.env['OPENAI_API_KEY'] ??= 'mock-token'
process.env['NESSIE_DB_URL'] ??= process.env['DATABASE_URL'] ?? ''
// A drain must not be able to sit through the rest of the turn: with a 1 ms
// grace the loop gives up as soon as the signal fires.
process.env['NESSIE_RUN_DRAIN_GRACE_MS'] = '1'

const SCHEDULE_CALL_ID = 'mock-call-schedule-task-1'
const FIND_CALL_ID = 'mock-call-channel-find-1'

const SCENARIO = {
  defaults: { latencyMs: 0, model: 'mock-model' },
  description: 'Turn 0 schedules a task and looks a channel up; turn 1 answers.',
  name: 'tool-effect-ledger',
  turns: [
    {
      latencyMs: 0,
      text: 'Scheduling that, and checking where to post it.',
      toolCalls: [
        {
          arguments: {
            instructions: 'Post the weekly digest.',
            name: 'ledger-probe-schedule',
            schedule: { at: '2031-01-01T09:00:00Z', kind: 'once' },
          },
          toolCallId: SCHEDULE_CALL_ID,
          toolName: 'schedule_task',
        },
        {
          arguments: { query: 'digest' },
          toolCallId: FIND_CALL_ID,
          toolName: 'channel_find',
        },
      ],
      usage: { inputTokens: 120, outputTokens: 20 },
    },
    {
      // Slow on purpose: it guarantees a window between the tool settling and
      // the run terminalising (which sheds the claims), so a test that has to
      // observe the claim in flight is not racing the end of the run.
      latencyMs: 600,
      text: 'Done — the digest is scheduled.',
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
  return { harnessModule, pipeline, runJob, server }
}

// One server and one pipeline for the file: the first worker import freezes the
// provider URL, so a second server would never be reached.
let harness: Harness | null = null
const useHarness = async (): Promise<Harness> => {
  harness ??= await startHarness()
  return harness
}

type EffectRow = {
  dispatched_at: Date
  result: { output?: string; success?: boolean } | null
  settled_at: Date | null
  state: string
  tool_call_id: string
  tool_name: string
}

const effectRows = async (harnessed: Harness, runId: string): Promise<EffectRow[]> => {
  const rows = await harnessed.pipeline.pool.query<EffectRow>(
    `SELECT tool_call_id, tool_name, state, result, dispatched_at, settled_at
       FROM run_tool_effects WHERE run_id = $1::uuid ORDER BY tool_call_id`,
    [runId],
  )
  return rows.rows
}

const triggers = (harnessed: Harness, agentId: string) =>
  harnessed.pipeline.prisma.agentTrigger.findMany({
    select: { createdAt: true, id: true },
    where: { agentId },
  })

const runStatus = async (harnessed: Harness, runId: string): Promise<string> =>
  (await harnessed.pipeline.prisma.run.findUniqueOrThrow({
    select: { status: true },
    where: { id: runId },
  })).status

/**
 * Stop the execution the instant `schedule_task` has really run, which is the
 * state a worker dies in — and, crucially, before the run posts its answer.
 *
 * The signal is the crash checkpoint's own recorded result, not anything this
 * change adds: it fires at the same point whether or not the ledger exists, so
 * a run of this file against the unfixed code stops in exactly the same place
 * and the assertions below measure the ledger rather than the harness. It also
 * lands strictly AFTER the ledger settles its claim, because the settle is
 * awaited inside the tool's own dispatch.
 *
 * Keyed on the schedule call's own id, never on "any recorded tool": the two
 * calls in the batch run concurrently, and `channel_find` settles first often
 * enough that a generic wait aborts the run before the probe has done anything.
 */
const stopWhenScheduleRecorded = async (
  harnessed: Harness,
  runId: string,
  abort: AbortController,
): Promise<void> => {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const rows = await harnessed.pipeline.pool.query<{ recorded: boolean }>(
      `SELECT (crash_state -> 'toolResults' -> $2) IS NOT NULL AS recorded
         FROM run_checkpoints WHERE run_id = $1::uuid`,
      [runId, SCHEDULE_CALL_ID],
    )
    if (rows.rows[0]?.recorded === true) {
      abort.abort()
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`run ${runId} never recorded the schedule_task result in its crash checkpoint`)
}

const finish = async (
  harnessed: Harness,
  threadId: string,
  scope: Parameters<Harness['harnessModule']['cleanupScope']>[2],
  runIds: string[],
): Promise<void> => {
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

runDatabaseTest(
  'the claim is committed before the side effect, settles `completed`, and a read-only call is never claimed',
  async () => {
    const harnessed = await useHarness()
    const { pipeline } = harnessed
    const scope = await harnessed.harnessModule.seedScope(pipeline.prisma, 'tool-effect')
    const seeded = await harnessed.harnessModule.seedRun(
      pipeline.prisma,
      scope,
      'Schedule the weekly digest.',
    )

    try {
      const abort = new AbortController()
      const watcher = stopWhenScheduleRecorded(harnessed, seeded.runId, abort)
      await harnessed.runJob.executeRunJob(
        pipeline.deps,
        seeded.payload,
        { attempt: 1, maxAttempts: 3 },
        { signal: abort.signal },
      ).catch(() => undefined)
      await watcher

      const claimed = await effectRows(harnessed, seeded.runId)
      assert.deepEqual(
        claimed.map((row) => row.tool_name),
        ['schedule_task'],
        'only the side-effecting call is claimed; `channel_find` is `safe` and writes no row',
      )
      const claim = claimed[0]!
      assert.equal(claim.tool_call_id, SCHEDULE_CALL_ID)
      assert.equal(claim.state, 'completed')
      assert.notEqual(claim.settled_at, null)
      assert.equal(claim.result?.success, true, 'the settled row carries the recorded result')

      // The ordering that makes the claim worth writing: it was committed in
      // its own transaction BEFORE the tool's side effect, so a crash in
      // between leaves the claim and not the silence.
      const created = await triggers(harnessed, scope.agentId)
      assert.equal(created.length, 1, 'the tool really ran once')
      assert.ok(
        claim.dispatched_at.getTime() <= created[0]!.createdAt.getTime(),
        'the `dispatched` claim was durable before the side effect it covers',
      )
    } finally {
      await finish(harnessed, seeded.threadId, scope, [seeded.runId])
    }
  },
)

runDatabaseTest(
  'a `completed` claim answers a resume that has no checkpoint at all, and a terminal run sheds its claims',
  async () => {
    const harnessed = await useHarness()
    const { pipeline } = harnessed
    const scope = await harnessed.harnessModule.seedScope(pipeline.prisma, 'tool-effect-resume')
    const seeded = await harnessed.harnessModule.seedRun(
      pipeline.prisma,
      scope,
      'Schedule the weekly digest.',
    )

    try {
      const abort = new AbortController()
      const watcher = stopWhenScheduleRecorded(harnessed, seeded.runId, abort)
      await harnessed.runJob.executeRunJob(
        pipeline.deps,
        seeded.payload,
        { attempt: 1, maxAttempts: 3 },
        { signal: abort.signal },
      ).catch(() => undefined)
      await watcher
      assert.equal((await triggers(harnessed, scope.agentId)).length, 1)

      // Take the checkpoint away entirely. This is the cross-process case the
      // ledger exists for: a worker that died before its checkpoint write
      // landed, or a successor that never saw one. The run replays from the
      // prompt, the model asks for the same tool call id again — and the claim
      // must answer it instead of the tool running a second time.
      await pipeline.pool.query('DELETE FROM run_checkpoints WHERE run_id = $1::uuid', [
        seeded.runId,
      ])
      await pipeline.pool.query(
        `UPDATE runs
         SET status = 'running', executor_token = $2::uuid,
             executor_heartbeat_at = now() - interval '5 minutes'
         WHERE id = $1::uuid`,
        [seeded.runId, randomUUID()],
      )

      await harnessed.runJob.executeRunJob(
        pipeline.deps,
        seeded.payload,
        { attempt: 2, maxAttempts: 3 },
      )

      assert.equal(
        (await triggers(harnessed, scope.agentId)).length,
        1,
        'the resumed run read the claim: the schedule was created once, not twice',
      )
      assert.equal(await runStatus(harnessed, seeded.runId), 'completed')
      assert.deepEqual(
        await effectRows(harnessed, seeded.runId),
        [],
        'a terminal run sheds its tool-effect claims',
      )
    } finally {
      await finish(harnessed, seeded.threadId, scope, [seeded.runId])
    }
  },
)

runDatabaseTest(
  'a claim left `dispatched` makes the resume report an unknown outcome instead of re-running the tool',
  async () => {
    const harnessed = await useHarness()
    const { pipeline } = harnessed
    const scope = await harnessed.harnessModule.seedScope(pipeline.prisma, 'tool-effect-unknown')
    const seeded = await harnessed.harnessModule.seedRun(
      pipeline.prisma,
      scope,
      'Schedule the weekly digest.',
    )

    try {
      // The crash this exists for, staged exactly: the side effect committed at
      // the provider, and the worker died before the settle could land. All
      // that survives is a `dispatched` row.
      await pipeline.pool.query(
        `INSERT INTO run_tool_effects (id, run_id, tool_call_id, tool_name, state, dispatched_at)
         VALUES (gen_random_uuid(), $1::uuid, $2, 'schedule_task', 'dispatched', now())`,
        [seeded.runId, SCHEDULE_CALL_ID],
      )

      await harnessed.runJob.executeRunJob(
        pipeline.deps,
        seeded.payload,
        { attempt: 1, maxAttempts: 3 },
      )

      assert.equal(
        (await triggers(harnessed, scope.agentId)).length,
        0,
        'the tool was NOT re-executed: an unknown outcome is never resolved by repeating it',
      )
      const toolCalls = await pipeline.prisma.toolCall.findMany({
        select: { outputPreview: true },
        where: { runId: seeded.runId, toolName: 'schedule_task' },
      })
      assert.equal(toolCalls.length, 1, 'the model was answered for the call it asked for')
      assert.match(
        toolCalls[0]?.outputPreview ?? '',
        /NOT known whether it took effect/,
        'and told plainly that the outcome is unknown, not a fabricated success or failure',
      )
      assert.match(toolCalls[0]?.outputPreview ?? '', /not been repeated/)
    } finally {
      await finish(harnessed, seeded.threadId, scope, [seeded.runId])
    }
  },
)

runDatabaseTest('harness teardown', async () => {
  if (!harness) return
  await harness.pipeline.stop()
  await harness.server.close()
  harness = null
})
