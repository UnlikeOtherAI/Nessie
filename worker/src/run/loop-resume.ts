// What an agentic-loop execution carries, how it is snapshotted, and how a
// drain cuts it short.
//
// Everything here is pure: no database, no Prisma, no provider. The loop
// produces a `LoopResumeState` at each safe boundary and accepts one back to
// pick up where a dead executor stopped; `worker/src/run/execute/crash-checkpoint.ts`
// is what makes those snapshots durable.
//
// See docs/standards/horizontal-scaling.md invariant 4.

import type { InvocationRecord, ProviderMessage, ProviderToolCall } from '@nessie/runtime'
import type { CompactionGovernor } from './context-window.js'
import type { ExecuteToolFn, ExecutedToolResult, PrepareToolFn } from './tool-batch.js'

/**
 * This worker is draining and ran out of the short grace it allows an in-flight
 * inference or tool batch. The run is NOT failed: its crash checkpoint is
 * written, its executor token released, and the queue job is nacked so another
 * worker claims it immediately and resumes from the checkpoint.
 *
 * The message is the nack reason verbatim — `PgQueueProvider.runClaimedJob`
 * records `error.message` in `queue_jobs.error_message` — so an operator
 * reading a re-queued job sees why it moved rather than a stack trace.
 */
export const WORKER_DRAIN_NACK_REASON = 'worker_drain'

export class RunDrainedError extends Error {
  readonly runId: string | null

  constructor(runId: string | null = null) {
    super(WORKER_DRAIN_NACK_REASON)
    this.name = 'RunDrainedError'
    this.runId = runId
  }
}

/** One tool call that already ran, so a resumed batch does not run it again. */
export type RecordedToolResult = {
  inputSummary: string
  output: string
  success: boolean
  toolName: string
}

/**
 * The loop's whole working state at a safe boundary.
 *
 * "Safe" means every tool wrapper of the previous batch has settled, or the
 * next batch has not started — the same two points compaction and the
 * cooperative cancel probe use. `messages` is the assembled conversation
 * (initial prompt, assistant turns, tool results); `invocations` is the live
 * accumulator, so a resumed run neither re-bills nor loses the spend already
 * recorded. `pendingToolCalls` is non-null only for the snapshot taken
 * immediately before a batch dispatches: the assistant message requesting them
 * is already in `messages`, so a resume has to re-enter that batch rather than
 * ask the provider again.
 */
export type LoopResumeState = {
  compactionAttempts: number
  compactionLastIteration: number | null
  /** Wall-clock already spent by earlier executions of this run. */
  elapsedMs: number
  invocations: InvocationRecord[]
  iterations: number
  lastAssistantText: string
  messages: ProviderMessage[]
  pendingToolCalls: ProviderToolCall[] | null
  /**
   * Inference retries already spent. Carried because the retry budget is a
   * per-run allowance, not a per-executor one: a run that crashes inside its
   * retries and is re-claimed must continue counting, or a crash-looping run
   * gets six fresh attempts from every worker that touches it.
   */
  retriesUsed: number
  /** Loop-detection counters, so a resumed run does not restart its patience. */
  signatureCounts: Record<string, number>
  toolCallsUsed: number
  /**
   * The circuit breaker's per-tool consecutive-failure counts, so a tool that
   * has been failing across executions still trips instead of being retried
   * forever by a run that keeps being re-claimed. Boundary-aligned for the same
   * reason `signatureCounts` is: a re-entered batch replays its own failures
   * onto these counts, so a mid-batch snapshot would count them twice.
   */
  toolFailureCounts: Record<string, number>
  toolMs: number
  toolResults: Record<string, RecordedToolResult>
  woundDown: boolean
}

/**
 * A tool whose result reached durable storage never runs a second time.
 *
 * That is the real guarantee, and it is deliberately narrower than "a tool runs
 * at most once across every execution of a run", which this cannot promise. The
 * irreducible window is between a tool's side effect committing (the mail
 * leaves the provider, inside `executeTool`) and the persist of its record
 * committing in Postgres: a worker that dies in there leaves no record of a
 * call that really happened, and the resumed run runs it again. Nothing short
 * of a distributed transaction with the mail provider closes that window;
 * everything on this side of it is closed here — the persist is issued the
 * instant the record is taken, the persists are serialised so a slow one can
 * never overwrite a later one's state, and the loop makes no further progress
 * until the persist for the call it just ran has settled.
 *
 * Both dispatch seams are wrapped, because which one carries a call depends on
 * the caller: `executeToolBatch` uses `prepareTool` when it is supplied (the
 * main run loop, which authorizes ahead of dispatch) and `executeTool`
 * otherwise (delegate sub-agents, unit tests). A call whose result an earlier
 * execution recorded is answered from the record — without re-authorizing,
 * because re-running the gate would consume a second one-time approval proof
 * for work that is already done.
 */
export type ToolExecutionRecorder = {
  executeTool: ExecuteToolFn
  prepareTool: PrepareToolFn | undefined
  recorded: () => Record<string, RecordedToolResult>
}

export const createToolExecutionRecorder = (input: {
  executeTool: ExecuteToolFn
  /** Persist the updated record; called after each real execution settles. */
  onRecorded: () => Promise<void>
  prepareTool?: PrepareToolFn
  restored?: Record<string, RecordedToolResult>
}): ToolExecutionRecorder => {
  const results = new Map<string, RecordedToolResult>(Object.entries(input.restored ?? {}))

  // Persists run one at a time, in the order the records were taken.
  //
  // The calls in one batch overlap, so without this two persists are in flight
  // together on different pool connections and commit in whatever order the
  // database finishes them: a persist that snapshotted `{T1}` committing after
  // one that snapshotted `{T1, T2}` leaves a durable row with no T2 in it, and
  // the next crash re-runs T2's side effect — the exact duplicate this recorder
  // exists to prevent. Chaining means each call builds its state only after the
  // previous write has committed, so the last write always carries every record
  // taken before it. The invariant: after N concurrent records, the durable row
  // contains all N.
  let persistQueue: Promise<void> = Promise.resolve()
  const persist = (): Promise<void> => {
    const queued = persistQueue.then(() => input.onRecorded())
    // The chain must survive a failed write — the caller still sees the
    // rejection, but a later record must not inherit it and skip its own
    // persist.
    persistQueue = queued.catch(() => undefined)
    return queued
  }

  const record = async (
    toolName: string,
    toolCallId: string,
    result: ExecutedToolResult,
  ): Promise<ExecutedToolResult> => {
    // A suspension is not an execution: the tool never ran, and recording it
    // would make the resumed run skip the approval it is waiting for.
    if (result.pendingApproval || result.pendingInput) return result
    results.set(toolCallId, {
      inputSummary: result.inputSummary,
      output: result.output,
      success: result.success,
      toolName: result.toolName ?? toolName,
    })
    await persist()
    return result
  }

  const { prepareTool } = input
  return {
    executeTool: async (toolName, args, toolCallId) => {
      const already = results.get(toolCallId)
      if (already) return { ...already, toolCallId }
      return record(toolName, toolCallId, await input.executeTool(toolName, args, toolCallId))
    },
    prepareTool: prepareTool
      ? async (toolName, args, toolCallId) => {
        const already = results.get(toolCallId)
        if (already) {
          return { execute: async () => ({ ...already, toolCallId }), kind: 'execute' }
        }
        const prepared = await prepareTool(toolName, args, toolCallId)
        if (prepared.kind === 'suspend') return prepared
        return {
          execute: async () => record(toolName, toolCallId, await prepared.execute()),
          kind: 'execute',
        }
      }
      : undefined,
    recorded: () => Object.fromEntries(results),
  }
}

/**
 * Replay a snapshot's compaction history onto a fresh governor.
 *
 * The governor keeps its counters in a closure and exposes only
 * `recordAttempt`, which is enough: calling it once per recorded attempt, with
 * the last attempt's iteration, reconstructs both the attempt count and the
 * cooldown anchor exactly. A resumed run therefore inherits the compaction
 * ceiling instead of getting a second full allowance of model calls.
 */
export const restoreCompactionGovernor = (
  governor: CompactionGovernor,
  state: Pick<LoopResumeState, 'compactionAttempts' | 'compactionLastIteration'>,
): void => {
  for (let attempt = 0; attempt < state.compactionAttempts; attempt += 1) {
    governor.recordAttempt(state.compactionLastIteration ?? 0)
  }
}

/**
 * The drain deadline.
 *
 * A drain is only useful if it is bounded: "finish what you are doing" turns a
 * sixty-second shutdown into a forty-five-minute one when the thing being
 * finished is an agentic run. So the gate gives whatever is in flight a few
 * seconds after the abort, and after that every boundary check throws.
 *
 * `expire()` is a promise that settles when the grace runs out, for racing an
 * inference or a tool batch that would otherwise outlast it; `assert()` is the
 * cheap boundary check. Both are inert until the signal actually fires.
 */
export type DrainGate = {
  aborted: () => boolean
  assert: () => void
  expiry: <T>(work: Promise<T>) => Promise<T>
}

export const DEFAULT_DRAIN_GRACE_MS = 5_000

export const resolveDrainGraceMs = (): number => {
  const raw = Number(process.env['NESSIE_RUN_DRAIN_GRACE_MS'])
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DRAIN_GRACE_MS
}

export const createDrainGate = (
  signal: AbortSignal | undefined,
  graceMs: number = resolveDrainGraceMs(),
): DrainGate => {
  if (!signal) {
    return {
      aborted: () => false,
      assert: () => undefined,
      expiry: (work) => work,
    }
  }
  return {
    aborted: () => signal.aborted,
    assert: () => {
      if (signal.aborted) throw new RunDrainedError()
    },
    expiry: async <T>(work: Promise<T>): Promise<T> => {
      // The grace timer is armed by the abort, not by the call: on a healthy
      // worker this races against a promise that never settles, which costs one
      // listener rather than a timer per inference call.
      let timer: ReturnType<typeof setTimeout> | null = null
      const arm = (reject: (error: Error) => void) => (): void => {
        timer = setTimeout(() => reject(new RunDrainedError()), graceMs)
        timer.unref()
      }
      let disarm = (): void => undefined
      const expired = new Promise<never>((_, reject) => {
        const onAbort = arm(reject)
        disarm = (): void => {
          signal.removeEventListener('abort', onAbort)
          if (timer) clearTimeout(timer)
        }
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      })
      try {
        return await Promise.race([work, expired])
      } finally {
        disarm()
      }
    },
  }
}
