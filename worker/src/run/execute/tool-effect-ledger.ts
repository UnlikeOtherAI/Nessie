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

/**
 * The states a claimed call can be in — two that OBSERVED an outcome and two
 * that did not. The split is the whole of the file's logic:
 *
 * - `completed` — the tool returned, reporting success. Replayed.
 * - `failed` — the tool returned, reporting failure. Also replayed: the result
 *   is durable and is the one the model already saw, so a later execution hands
 *   back the same text rather than making the call again. This is what the
 *   crash checkpoint does with the same result on the fast path, and the two
 *   mechanisms are required to agree.
 * - `dispatched` — claimed, and nothing settled it. Either the call is in
 *   flight, or the execution making it died before it could settle.
 * - `interrupted` — the call was dispatched and the dispatch THREW. A throw is
 *   not a failure; see the `catch` in `dispatch` for why.
 *
 * The last two answer identically (`unknownOutcome`), so nothing downstream
 * branches on which. They stay separate because they record different
 * histories: an operator reading the table can tell a claim abandoned in flight
 * (`dispatched`, `settled_at` null) from one that ended in an error nobody
 * could interpret (`interrupted`, `settled_at` set) — and `dispatched` is also
 * what a fresh claim leaves, so folding them would erase that.
 *
 * **No state is repeatable.** Every row that exists answers the call it belongs
 * to, whether by replaying a result or by reporting an unknown outcome, so
 * there is no path on which a claimed call is executed a second time while its
 * row says something else. (A model that wants to retry a failed call issues a
 * new call, with a new id, which has no row.) `state` is a free-text column
 * precisely so a state can be added without a migration — see the
 * `RunToolEffect.state` comment in `schema.prisma` — and an unrecognised one,
 * from a newer deploy, reads as unknown.
 *
 * Rows written by the previous deploy need no migration and get no wrong
 * answer. It wrote `completed` for every call that returned, success or not, so
 * those rows still replay their recorded result; and it wrote `failed` only
 * from the `catch`, so such a row carries no result, fails the shape check in
 * `readRecordedResult`, and is read as unknown — which is what a throw meant
 * then and means now.
 */
export const TOOL_EFFECT_STATES = {
  completed: 'completed',
  dispatched: 'dispatched',
  failed: 'failed',
  interrupted: 'interrupted',
} as const

/** States in which the tool RETURNED, so `result` is the outcome it reported. */
const OBSERVED_STATES: ReadonlySet<string> = new Set([
  TOOL_EFFECT_STATES.completed,
  TOOL_EFFECT_STATES.failed,
])

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

/**
 * What the model is told when the claim it collided with belongs to a DIFFERENT
 * tool.
 *
 * `(run_id, tool_call_id)` is unique, so a row whose `tool_name` is not this
 * call's name means the provider reused an id within the run. The row's result
 * is another tool's; replaying it would answer this call with a stranger's
 * output, and reading its state would report an unknown outcome for a call that
 * never started. Neither is defensible, so the collision is reported as what it
 * is and the tool does NOT run — running it would write this call's outcome
 * over the other call's row, losing the guarantee for both.
 */
const idCollision = (
  toolName: string,
  claimedToolName: string,
  toolCallId: string,
): ExecutedToolResult => ({
  inputSummary: `${toolName} (tool-call id collision)`,
  output:
    `The tool-call id \`${toolCallId}\` was already used in this run for a call to `
    + `\`${claimedToolName}\`, so this call to \`${toolName}\` cannot be told apart from it. `
    + 'It has NOT been executed. Issue the call again with a distinct tool-call id.',
  success: false,
  toolCallId,
  toolName,
})

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

/** The name sets a run's dispatch consults, held by reference. */
export type ExternalDispatchSources = {
  executorToolset: { handledNames: ReadonlySet<string> }
  mcpView: { handledNames: ReadonlySet<string> }
}

/**
 * Does this name reach a transport that leaves Nessie?
 *
 * A FUNCTION over the live sets, never a set copied at loop setup, because the
 * MCP view is mutable by the run itself: `mcp_load_tools` / `mcp_drop_tools`
 * rewrite what the model can see mid-run, and `agent-loop.ts` decides where to
 * dispatch a call by asking `mcpView.handledNames` and
 * `executorToolset.handledNames` at the moment of the call. The claim decision
 * has to ask the same two objects at the same moment: a snapshot is a second
 * source of truth, and the day the two disagree the disagreement is a tool
 * dispatched to a connector with no claim behind it — which is the whole window
 * this file exists to close.
 *
 * (Today `handledNames` holds every entry the view can dispatch whether its
 * schema is currently loaded or not, so a snapshot would in fact still agree.
 * That is a property of `mcp-toolset-deferred.ts`, pinned by its own test, not
 * something this file may assume.)
 */
export const externalDispatchPredicate = (
  sources: ExternalDispatchSources,
): ((toolName: string) => boolean) =>
  (toolName) =>
    sources.mcpView.handledNames.has(toolName)
    || sources.executorToolset.handledNames.has(toolName)

export type ToolEffectScope = {
  /**
   * Asked per call, never once: see `externalDispatchPredicate`. Deliberately
   * NOT the same value the authorization gate's `externalToolNames` carries —
   * that set also holds the builtin tool-spec meta tool, which only rewrites
   * this run's own view of its tool list and reaches nothing outside Nessie.
   */
  isExternalDispatch: (toolName: string) => boolean
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
  isExternalDispatch: (toolName: string) => boolean,
): boolean =>
  EFFECTFUL_BUILTIN_TOOL_IDS.has(toolName) || isExternalDispatch(toolName)

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
  /**
   * TOTAL by construction: a row that exists always answers the call it
   * belongs to. There is no arm that returns "run it again", so no path on
   * which a claimed call is executed a second time — the fall-through that used
   * to exist ran the tool WITHOUT taking a fresh claim, and since the settle is
   * scoped to `dispatched` it matched no row, leaving the repeat unrecorded and
   * a third execution free to run the call a third time.
   */
  const answerFromRow = (
    row: EffectRow,
    toolName: string,
    toolCallId: string,
  ): ExecutedToolResult => {
    // The id guard, before any state is read. `(run_id, tool_call_id)` is
    // unique, so a stored name that is not this call's means the provider
    // reused an id: this row describes somebody else's call and answers
    // nothing about this one. An empty stored name is an older row this module
    // wrote before it recorded one, and is trusted as before.
    if (row.toolName && row.toolName !== toolName) {
      return idCollision(toolName, row.toolName, toolCallId)
    }
    if (OBSERVED_STATES.has(row.state)) {
      const recorded = readRecordedResult(row)
      if (recorded) return replay(recorded, toolCallId)
      // The tool returned, but its recorded result is unreadable: what happened
      // is known to have happened and unknown in detail, which is exactly the
      // unknown answer.
      return unknownOutcome(row.toolName || toolName, toolCallId)
    }
    // `dispatched` (claimed, never settled) and `interrupted` (dispatched, then
    // threw): nobody observed an outcome, and an unobserved outcome is never
    // resolved by repeating the call. An unrecognised state — a row from a
    // newer deploy — lands here too, the safe read of a state this code cannot
    // interpret.
    return unknownOutcome(row.toolName || toolName, toolCallId)
  }

  const dispatch = async (
    toolName: string,
    toolCallId: string,
    execute: () => Promise<ExecutedToolResult>,
  ): Promise<ExecutedToolResult> => {
    // Two rounds at most. A conflicting row answers the call; the only way it
    // does not is that it was deleted between the conflict and the read (a
    // competing executor's run reaching a terminal status sheds every claim),
    // and the answer to that is to claim it again — never to run the tool on a
    // row this execution does not hold.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (await claimDispatch(prisma, scope.runId, toolCallId, toolName)) break
      const row = await loadEffect(prisma, scope.runId, toolCallId)
      if (row) return answerFromRow(row, toolName, toolCallId)
    }
    let result: ExecutedToolResult
    try {
      result = await execute()
    } catch (error) {
      // A THROW IS NOT A FAILURE. `failed` means the tool returned and said so;
      // a throw means the tool reported nothing at all, and the claim was
      // already committed, so the dispatch may have reached the far side and
      // come apart afterwards — an executor command that ran on the person's
      // machine before a later audit write hit a transient database error, an
      // MCP call the server executed whose response was lost to a timeout. The
      // row therefore settles `interrupted`, which `answerFromRow` reads as
      // unknown, so a later execution reports the unknown outcome instead of
      // sending a second command or filing a second ticket.
      //
      // This is deliberately conservative at one edge: a throw raised BEFORE
      // the transport — an authorization gate hitting a dead database, say —
      // is indistinguishable from one raised after it, and is treated as
      // unknown too. That costs a tool call the agent can make again; the
      // unknown-outcome text tells it exactly that, and asks it to check first.
      // The opposite mistake costs a duplicate nobody can take back.
      await settleDispatch(prisma, scope.runId, toolCallId, {
        result: null,
        state: TOOL_EFFECT_STATES.interrupted,
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
    // The tool returned, so the outcome was observed either way. Which of the
    // two observed states is recorded changes nothing about what a later
    // execution is told — both replay `result` — but it keeps the column
    // honest: `failed` is a failure the tool REPORTED, and is the only thing
    // that ever writes it.
    await settleDispatch(prisma, scope.runId, toolCallId, {
      result: asRecorded(toolName, result),
      state: result.success ? TOOL_EFFECT_STATES.completed : TOOL_EFFECT_STATES.failed,
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

  /**
   * Is this call claimable at all?
   *
   * The claim is keyed on `(runId, toolCallId)`, so an id the provider left
   * empty is not a key: every id-less call in the run would collide on the same
   * row and be answered from the first one's output. A run with no id has no
   * idempotency to offer, and saying so by running the tool unclaimed is
   * strictly better than answering the second call with the first's result.
   *
   * The `typeof` is not redundant with the parameter's type: the id comes from
   * a provider's response, and a missing one arrives as `undefined` however the
   * signature is written.
   */
  const claimable = (toolName: string, toolCallId: string): boolean =>
    typeof toolCallId === 'string'
    && toolCallId.trim().length > 0
    && toolCallNeedsEffectRecord(toolName, scope.isExternalDispatch)

  const { prepareTool } = seams
  return {
    executeTool: async (toolName, args, toolCallId) => {
      if (!claimable(toolName, toolCallId)) {
        return seams.executeTool(toolName, args, toolCallId)
      }
      const answer = await answerBeforeAuthorizing(toolName, toolCallId)
      if (answer) return answer
      return dispatch(toolName, toolCallId, () => seams.executeTool(toolName, args, toolCallId))
    },
    prepareTool: prepareTool
      ? async (toolName, args, toolCallId) => {
        if (!claimable(toolName, toolCallId)) {
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
