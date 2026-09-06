import { EFFECTFUL_BUILTIN_TOOL_IDS } from '@nessie/runtime'
import { Prisma, type PrismaClient } from '@prisma/client'

import type {
  ExecuteToolFn,
  ExecutedToolResult,
  PrepareToolFn,
} from '../tool-batch.js'
import type { RecordedToolResult } from '../loop-resume.js'

// The durable half of tool idempotency (horizontal scaling, invariant 4).
//
// `loop-resume.ts`'s recorder writes a tool's result AFTER the tool returns and
// persists it with the crash checkpoint. That makes a resume skip tools it
// already ran, but it cannot close one window: between a side effect committing
// at the provider (the mail leaves) and its record committing in Postgres, a
// worker that dies leaves no trace of a call that really happened — so the
// resumed run does it again, and somebody gets two of something.
//
// This ledger closes it from the other side. Before a side-effecting call is
// dispatched, one row is committed on its own saying the call is being made.
// A later execution that finds that row knows the call was STARTED, which is
// strictly more than the checkpoint could ever tell it, and answers accordingly
// instead of running the tool a second time.
//
// PRECEDENCE, stated once because two mechanisms now answer the same question:
//
//   1. The crash checkpoint's recorded results win. They are in memory (or were
//      restored from the run's checkpoint at claim time), they carry the exact
//      result the model already saw, and they cost no query. The recorder wraps
//      THIS ledger — see `agent-loop.ts` — so a recorded call never reaches the
//      code below at all.
//   2. This table is the backstop for everything the checkpoint could not say:
//      a crash before the checkpoint's write landed, a checkpoint too large to
//      persist, a run re-claimed by a process that never saw one.
//
// The two agree by construction because they are keyed the same way — by the
// provider's tool-call id within the run.

/** The three states a claimed call can be in. `dispatched` is the whole point. */
export const TOOL_EFFECT_STATES = {
  completed: 'completed',
  dispatched: 'dispatched',
  failed: 'failed',
} as const

/**
 * What a resumed run tells the model about a call whose outcome nobody knows.
 *
 * Deliberately not a failure and not a success: the tool may well have sent the
 * mail. Fabricating either would make the agent act on something that is not
 * known, so the text says exactly what is known — the call was started, the
 * result was never recorded, and it has NOT been repeated — and hands the
 * decision to the agent, which can look and see.
 */
export const unknownOutcomeMessage = (toolName: string): string =>
  `The call to \`${toolName}\` was started by an earlier execution of this run, but that `
  + 'execution stopped before the outcome was recorded, so it is NOT known whether it took '
  + 'effect. It has deliberately not been repeated: repeating it could duplicate a real side '
  + 'effect (a second message, mail, ticket or calendar entry). Check whether the action '
  + 'already happened before deciding what to do — and only call it again if you have '
  + 'established that it did not.'

type EffectRow = {
  result: Prisma.JsonValue | null
  state: string
  toolName: string
}

const readRecordedResult = (row: EffectRow): RecordedToolResult | null => {
  const raw = row.result
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const recorded = raw as unknown as RecordedToolResult
  // A shape check rather than a schema, for the reason `loadCrashCheckpoint`
  // gives: the only writer is this module in this same deploy, so the one thing
  // worth guarding is a row written by an older shape. An unreadable result is
  // treated as `dispatched` — unknown, never re-run — which is the safe read.
  if (typeof recorded.output !== 'string' || typeof recorded.success !== 'boolean') return null
  return recorded
}

const asRecorded = (
  toolName: string,
  result: ExecutedToolResult,
): RecordedToolResult => ({
  inputSummary: result.inputSummary,
  output: result.output,
  success: result.success,
  toolName: result.toolName ?? toolName,
})

const replay = (
  recorded: RecordedToolResult,
  toolCallId: string,
): ExecutedToolResult => ({ ...recorded, toolCallId })

const unknownOutcome = (
  toolName: string,
  toolCallId: string,
): ExecutedToolResult => ({
  inputSummary: `${toolName} (outcome unknown)`,
  output: unknownOutcomeMessage(toolName),
  // Neither flag is true of an unknown outcome, and one of them has to be
  // written. `false` is the honest half-truth: it keeps the run's `ToolCall`
  // telemetry from claiming a success nobody observed, and the circuit breaker
  // needs three consecutive failures to trip, so one unknown never disables a
  // tool. The output text is where the actual state of the world is stated.
  success: false,
  toolCallId,
  toolName,
})

export type ToolEffectLedger = {
  executeTool: ExecuteToolFn
  prepareTool: PrepareToolFn | undefined
}

export type ToolEffectScope = {
  /** Names the run dispatches through a transport that leaves Nessie. */
  externalToolNames: ReadonlySet<string>
  runId: string
}

/**
 * Is this call one whose duplicate somebody would see?
 *
 * Builtins answer from their own declaration (`EFFECTFUL_BUILTIN_TOOL_IDS`:
 * not `safe`, and in a category whose effects leave the agent's workspace).
 * Everything else the run can dispatch — an MCP server's tool, an HTTP
 * connector, an executor command — is claimed unconditionally: its name is
 * per installation, so no catalogue can classify it, and by construction the
 * call leaves Nessie.
 */
export const toolCallNeedsEffectRecord = (
  toolName: string,
  externalToolNames: ReadonlySet<string>,
): boolean =>
  EFFECTFUL_BUILTIN_TOOL_IDS.has(toolName) || externalToolNames.has(toolName)

/**
 * Claim the dispatch, in its own committed transaction.
 *
 * On its own deliberately: folded into a longer transaction it would become
 * durable only when that transaction committed, which is after the side effect
 * — precisely the window this exists to close. A single `createMany` runs in
 * Prisma's own implicit transaction, so the row is committed before the caller
 * dispatches anything.
 *
 * `skipDuplicates` is `INSERT … ON CONFLICT DO NOTHING` against the
 * `(run_id, tool_call_id)` unique index, so the count is the answer to "did
 * THIS execution claim the call". Zero means a row already exists — never
 * expected on the fast path, since the caller looked first, and the correct
 * answer to a race: whoever inserted first owns the dispatch.
 */
const claimDispatch = async (
  prisma: PrismaClient,
  runId: string,
  toolCallId: string,
  toolName: string,
): Promise<boolean> => {
  const { count } = await prisma.runToolEffect.createMany({
    data: [{ runId, state: TOOL_EFFECT_STATES.dispatched, toolCallId, toolName }],
    skipDuplicates: true,
  })
  return count > 0
}

const settleDispatch = async (
  prisma: PrismaClient,
  runId: string,
  toolCallId: string,
  settled: { result: RecordedToolResult | null; state: string },
): Promise<void> => {
  await prisma.runToolEffect.updateMany({
    data: {
      ...(settled.result
        ? { result: settled.result as unknown as Prisma.InputJsonValue }
        : {}),
      settledAt: new Date(),
      state: settled.state,
    },
    where: { runId, state: TOOL_EFFECT_STATES.dispatched, toolCallId },
  })
}

const loadEffect = (
  prisma: PrismaClient,
  runId: string,
  toolCallId: string,
): Promise<EffectRow | null> =>
  prisma.runToolEffect.findUnique({
    select: { result: true, state: true, toolName: true },
    where: { runId_toolCallId: { runId, toolCallId } },
  })

/**
 * Delete a run's claims. Called from `updateRunStatus`, the same chokepoint
 * that sheds the crash checkpoint, for the same reason: a finished run has
 * nothing left to resume, and a suspended one is continued by a NEW run whose
 * tool calls carry new ids, so its claims can only accumulate.
 *
 * Unfenced on purpose. Unlike the crash checkpoint there is nothing here a
 * competing executor could destroy that matters: the claims exist to stop a
 * RESUME of this run id from repeating a call, and the caller is writing the
 * status that says this run id will never be resumed again.
 */
export const clearRunToolEffects = async (
  prisma: PrismaClient,
  runId: string,
): Promise<void> => {
  await prisma.runToolEffect.deleteMany({ where: { runId } })
}

/**
 * Wrap a run's dispatch seams so every side-effecting call is claimed durably
 * before it runs, and a resumed run answers from the claim instead of repeating
 * it.
 *
 * Both seams are wrapped for the reason the recorder gives: which one carries a
 * call depends on the caller, and `prepareTool` is the one the main run loop
 * uses. A call the ledger answers is answered WITHOUT re-authorising — running
 * the gate again would consume a second one-time approval proof for work that
 * may already be done.
 */
export const createToolEffectLedger = (
  prisma: PrismaClient,
  scope: ToolEffectScope,
  seams: { executeTool: ExecuteToolFn; prepareTool?: PrepareToolFn },
): ToolEffectLedger => {
  const answerFromRow = (
    row: EffectRow,
    toolName: string,
    toolCallId: string,
  ): ExecutedToolResult | null => {
    if (row.state === TOOL_EFFECT_STATES.completed) {
      const recorded = readRecordedResult(row)
      if (recorded) return replay(recorded, toolCallId)
      // Completed, but the result is unreadable: the outcome is known to have
      // happened and unknown in detail, which is the `dispatched` answer.
      return unknownOutcome(row.toolName || toolName, toolCallId)
    }
    if (row.state === TOOL_EFFECT_STATES.dispatched) {
      return unknownOutcome(row.toolName || toolName, toolCallId)
    }
    // `failed`: the tool ran and reported failure, and that failure was
    // durable. Nothing was left half-done that a repeat would duplicate, so the
    // call is executed again exactly as it would be without a ledger.
    return null
  }

  const dispatch = async (
    toolName: string,
    toolCallId: string,
    execute: () => Promise<ExecutedToolResult>,
  ): Promise<ExecutedToolResult> => {
    if (!(await claimDispatch(prisma, scope.runId, toolCallId, toolName))) {
      const row = await loadEffect(prisma, scope.runId, toolCallId)
      const answer = row ? answerFromRow(row, toolName, toolCallId) : null
      if (answer) return answer
    }
    let result: ExecutedToolResult
    try {
      result = await execute()
    } catch (error) {
      await settleDispatch(prisma, scope.runId, toolCallId, {
        result: null,
        state: TOOL_EFFECT_STATES.failed,
      }).catch(() => undefined)
      throw error
    }
    // A suspension is not an execution — the tool never ran — so the claim is
    // withdrawn rather than settled, exactly as the recorder declines to record
    // one. Leaving it would make the approved continuation report an unknown
    // outcome for a call that is still waiting to be made.
    if (result.pendingApproval || result.pendingInput) {
      await prisma.runToolEffect
        .deleteMany({ where: { runId: scope.runId, state: TOOL_EFFECT_STATES.dispatched, toolCallId } })
        .catch(() => undefined)
      return result
    }
    await settleDispatch(prisma, scope.runId, toolCallId, {
      result: asRecorded(toolName, result),
      state: TOOL_EFFECT_STATES.completed,
    })
    return result
  }

  const answerBeforeAuthorizing = async (
    toolName: string,
    toolCallId: string,
  ): Promise<ExecutedToolResult | null> => {
    const row = await loadEffect(prisma, scope.runId, toolCallId)
    return row ? answerFromRow(row, toolName, toolCallId) : null
  }

  const { prepareTool } = seams
  return {
    executeTool: async (toolName, args, toolCallId) => {
      if (!toolCallNeedsEffectRecord(toolName, scope.externalToolNames)) {
        return seams.executeTool(toolName, args, toolCallId)
      }
      const answer = await answerBeforeAuthorizing(toolName, toolCallId)
      if (answer) return answer
      return dispatch(toolName, toolCallId, () => seams.executeTool(toolName, args, toolCallId))
    },
    prepareTool: prepareTool
      ? async (toolName, args, toolCallId) => {
        if (!toolCallNeedsEffectRecord(toolName, scope.externalToolNames)) {
          return prepareTool(toolName, args, toolCallId)
        }
        const answer = await answerBeforeAuthorizing(toolName, toolCallId)
        if (answer) return { execute: async () => answer, kind: 'execute' }
        const prepared = await prepareTool(toolName, args, toolCallId)
        if (prepared.kind === 'suspend') return prepared
        // The claim goes inside `execute`, never here: a later call in the same
        // batch can still suspend the whole batch on its approval gate, and
        // `executeToolBatch` then discards every prepared execution before it
        // runs. Claiming at prepare time would mark those calls dispatched and
        // make the resumed run report an unknown outcome for tools that
        // provably never ran.
        return {
          execute: () => dispatch(toolName, toolCallId, prepared.execute),
          kind: 'execute',
        }
      }
      : undefined,
  }
}
