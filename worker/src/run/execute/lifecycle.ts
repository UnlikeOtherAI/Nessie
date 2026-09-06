import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'
import { applyReplyBookkeeping } from '@nessie/runtime'
import type { RunExecuteJobPayload, RunStatus, TaskStatus } from '@nessie/schemas'
import { parseAgentRunLimits } from '../run-budget.js'
import type { PgRealtimeTransport } from '@nessie/runtime'
import { releaseRunCloudBrowsers } from '../browser-cloud/release-hook.js'
import { clearCrashCheckpoint, clearCrashCheckpointForUnheldRun } from './crash-checkpoint.js'
import { clearRunToolEffects } from './tool-effect-ledger.js'
import { createConsumedSourceSink } from './disclosure-basis.js'
import type { ReplyPlacement, RunContext } from './types.js'
import { clearWorking } from './working-marker.js'
import { releaseAgentTodosForTerminalRun } from '@nessie/team-admin'

/**
 * This executor no longer owns the run: another one claimed it (our heartbeat
 * went stale, or we were slow), and its outcome belongs to that executor. The
 * job handler stops silently and acks — the work is being done elsewhere, so
 * neither a retry nor a terminal status write from here is wanted.
 */
export class RunFencedError extends Error {
  readonly runId: string

  constructor(runId: string) {
    super(`run ${runId} is executing on another worker; this executor was fenced out`)
    this.name = 'RunFencedError'
    this.runId = runId
  }
}

/**
 * How long an executor may go silent before another may take its run. Applied
 * with the database's clock, never the worker's: with N workers the comparison
 * is between machines whose clocks drift.
 */
const EXECUTOR_TAKEOVER_INTERVAL = '2 minutes'
const EXECUTOR_HEARTBEAT_MS = 30_000

type ExecutorFence = { fenced: boolean; runId: string; token: string | null }

// The claim this execution holds, carried by the run's own async context.
//
// Deliberately ambient rather than another parameter on `updateRunStatus`, for
// the reason spelled out in `browser-cloud/release-hook.ts`: the point of fusing
// an obligation to the one status chokepoint is that no caller participates.
// Eight terminal paths reach `updateRunStatus`; every one must carry the token,
// and a ninth added later must carry it without its author having to know.
//
// And deliberately execution-scoped rather than a module-level registry: the
// store is created per `executeRunJob` and dies with it, so there is nothing to
// leak, nothing to clean up on an exit path, and no per-process table that a
// second replica would need to see. The authority is `runs.executor_token` in
// Postgres; this only remembers which token THIS execution minted.
const executorFence = new AsyncLocalStorage<ExecutorFence>()

/** Run `fn` as the execution that may come to hold `runId`. */
export const withRunExecutorFence = <T>(
  runId: string,
  fn: () => Promise<T>,
): Promise<T> => executorFence.run({ fenced: false, runId, token: null }, fn)

// The fence only when it is this execution's own run and a claim has stamped a
// token on it. Everything else — a status written before the claim, a test
// driving a status directly — is unfenced, exactly as it was.
const heldFence = (runId: string): ExecutorFence | null => {
  const fence = executorFence.getStore()
  return fence && fence.runId === runId && fence.token !== null ? fence : null
}

/** Record that this execution holds `runId` under `token`. */
export const registerExecutorFence = (runId: string, token: string): void => {
  const fence = executorFence.getStore()
  if (fence && fence.runId === runId) fence.token = token
}

/** Give the claim up: from here the run is unfenced and someone else may hold it. */
export const releaseExecutorFence = (runId: string): void => {
  const fence = executorFence.getStore()
  if (fence && fence.runId === runId) fence.token = null
}

/**
 * The token this execution claimed `runId` with, or null when it holds no
 * claim. The crash checkpointer needs it by value: its write is a conditional
 * statement of its own rather than a status write, so it cannot ride the
 * ambient fence the way `updateRunStatus` does.
 */
export const currentExecutorToken = (runId: string): string | null =>
  heldFence(runId)?.token ?? null

/**
 * Hand a run back mid-flight, for a worker that is draining.
 *
 * Clearing the heartbeat alongside the token is the point: `claimRunForExecution`
 * admits a `running` run only once its executor has gone silent for the takeover
 * window, so releasing the token alone would leave the run parked for two
 * minutes while a nacked job sat pending. With a null heartbeat the next worker
 * claims it on its very next poll and resumes from the crash checkpoint — which
 * is what makes "drain within sixty seconds" true for a 45-minute run.
 *
 * Conditional on still holding the run, so a fenced-out executor cannot release
 * the winner's claim on its way out.
 */
export const releaseRunForDrain = async (
  prisma: PrismaClient,
  runId: string,
): Promise<void> => {
  const token = currentExecutorToken(runId)
  if (!token) return
  await prisma.$executeRaw`
    UPDATE runs
    SET executor_token = NULL, executor_heartbeat_at = NULL
    WHERE id = ${runId}::uuid AND executor_token = ${token}::uuid
  `
  releaseExecutorFence(runId)
}

/**
 * Stop the run here if a heartbeat has already discovered the takeover, so a
 * fenced-out executor abandons the loop at the next iteration boundary instead
 * of running to completion and only then finding it cannot write the outcome.
 */
export const assertExecutorHoldsRun = (runId: string): void => {
  if (heldFence(runId)?.fenced === true) throw new RunFencedError(runId)
}

/**
 * Refresh `executor_heartbeat_at` while the run executes, so no other executor
 * mistakes a live run for a crashed one.
 *
 * Only a zero-row UPDATE fences: that means the row no longer carries our
 * token, which is another executor holding it. A transport or database error is
 * logged and retried on the next tick — a blip must never abort a healthy run.
 * The timer is unref'd so it can never hold the process open, and the handle's
 * `stop` is called on every exit path.
 */
export const startExecutorHeartbeat = (
  prisma: PrismaClient,
  runId: string,
): { stop: () => void } => {
  const fence = heldFence(runId)
  if (!fence) return { stop: () => undefined }
  const timer = setInterval(() => {
    if (fence.fenced || fence.token === null) return
    void prisma
      .$executeRaw`
        UPDATE runs
        SET executor_heartbeat_at = now()
        WHERE id = ${runId}::uuid AND executor_token = ${fence.token}::uuid
      `
      .then((count) => {
        if (count > 0) return
        fence.fenced = true
        console.warn(
          `[worker] run ${runId} was taken over by another executor; abandoning it here`,
        )
      })
      .catch((error: unknown) => {
        console.warn('[worker] could not refresh executor heartbeat for run', runId, error)
      })
  }, EXECUTOR_HEARTBEAT_MS)
  timer.unref()
  return { stop: () => clearInterval(timer) }
}

export const updateTaskStatus = async (
  prisma: PrismaClient,
  taskId: string,
  status: TaskStatus,
): Promise<void> => {
  await prisma.task.update({
    where: { id: taskId },
    data: { status },
  })
}

export const updateRunStatus = async (
  prisma: PrismaClient,
  runId: string,
  status: RunStatus,
  // Supplied wherever the caller has one, so the cleared working marker
  // reaches open clients immediately. Its absence only delays the repaint to
  // the next refetch — the row is already gone either way.
  transport?: PgRealtimeTransport,
): Promise<void> => {
  const terminal =
    status === 'completed' || status === 'failed' || status === 'cancelled'
  // A suspended run is parked for a person, and the executor that resumes it
  // will be a different one. Releasing the token in the very statement that
  // parks the run is what lets that executor claim it without waiting out the
  // takeover window — and there is no window in which the run is suspended and
  // still fenced to a worker that has stopped executing it.
  const suspended = status === 'waiting_approval' || status === 'waiting_input'
  const data = {
    finishedAt: terminal ? new Date() : null,
    startedAt: status === 'running' ? new Date() : undefined,
    status,
    ...(suspended ? { executorToken: null } : {}),
  }
  const fence = heldFence(runId)
  // Read before the write below, because the suspended branch releases the
  // fence as part of parking the run — and the crash-state clear still has to
  // prove which executor is doing the clearing.
  const fenceToken = fence?.token ?? null
  if (fence === null) {
    // No claim holds the run here: a status written before the claim (the quiet
    // PA-presence cancellation), or a caller outside a run execution.
    // Unchanged behaviour, including throwing on a missing run.
    await prisma.run.update({ where: { id: runId }, data })
  } else {
    if (fence.fenced) throw new RunFencedError(runId)
    const { count } = await prisma.run.updateMany({
      where: { id: runId, executorToken: fence.token },
      data,
    })
    if (count === 0) {
      // Zero rows means the row stopped carrying our token: another executor
      // took the run over. Its outcome is that executor's to write, so this one
      // records nothing — not this status, and not the release hook below.
      fence.fenced = true
      throw new RunFencedError(runId)
    }
    // The row no longer carries the token we would fence on, so stop pretending
    // it does; the heartbeat reads the same registry and falls silent with it.
    if (suspended) releaseExecutorFence(runId)
  }

  // Crash state is shed here for the same reason the working marker below is:
  // fused to the one status chokepoint rather than to any single path, so a
  // ninth terminal path added later cannot leave a resumable checkpoint behind
  // a finished run. A terminal run has nothing left to resume; a suspended one
  // is resumed by a NEW run from its note, never in place by this one.
  //
  // Fenced on the token this execution claimed with, so a superseded executor
  // reaching a terminal status of its own cannot erase the state the live
  // executor is still writing. The unfenced variant is only for a status
  // written from outside any execution, which is the run's ending, not a
  // competitor for it.
  if (terminal || suspended) {
    try {
      await (fenceToken
        ? clearCrashCheckpoint(prisma, runId, fenceToken)
        : clearCrashCheckpointForUnheldRun(prisma, runId))
    } catch (error) {
      console.warn('[worker] could not clear crash checkpoint for run', runId, error)
    }
    // The run's tool-effect claims go with it, and here for the same reason:
    // there is one row per side-effecting tool call, so without a chokepoint
    // that sheds them the table grows with every call the platform ever makes.
    // A terminal run is never resumed, and a suspended one is continued by a
    // NEW run whose tool calls carry new ids — so from this statement onwards
    // nothing can consult these rows, which is exactly when they stop being
    // worth keeping. Unfenced, unlike the crash state above: a competing
    // executor cannot lose anything that matters by deleting claims for a run
    // this caller is declaring over. See `tool-effect-ledger.ts`.
    try {
      await clearRunToolEffects(prisma, runId)
    } catch (error) {
      console.warn('[worker] could not clear tool-effect claims for run', runId, error)
    }
  }

  // Clearing the "looking at this" reaction is fused to the terminal
  // transition rather than to any one terminal path, so completion, failure,
  // budget stop and cancellation all drop it without having to remember. A
  // crashed run is re-delivered by the queue and ends up here too, which is
  // what keeps the marker from outliving the work.
  if (!terminal) return
  // Wrapped: the run is already terminal in the database, and a decoration
  // must never be able to turn that into a thrown error.
  try {
    const run = await prisma.run.findUnique({
      select: { agentId: true, principalUserId: true, threadId: true, triggerMessageId: true },
      where: { id: runId },
    })
    await releaseAgentTodosForTerminalRun(prisma, runId)
    // Browser-hours are money, so this sits above the trigger-message
    // early-return: a run with no trigger message still opened a real browser.
    await releaseRunCloudBrowsers(runId)
    if (!run?.triggerMessageId) return
    await clearWorking(prisma, transport ?? null, {
      agentId: run.agentId,
      messageId: run.triggerMessageId,
      ...(run.principalUserId ? { onBehalfOfUserId: run.principalUserId } : {}),
      threadId: run.threadId,
    })
  } catch (error) {
    console.warn('[worker] could not clear working reaction for run', runId, error)
  }
}

export type RunClaim =
  | {
    claimed: true
    /**
     * The status the run carried before this claim. `running` means this
     * execution is taking over from an executor that went silent, so the
     * caller looks for a crash checkpoint to resume from rather than starting
     * the run again from its prompt.
     */
    priorStatus: RunStatus
    token: string
  }
  | { claimed: false; priorStatus: null; token: null }

// Atomic start claim: flips a still-claimable run to `running` and stamps this
// executor's fencing token in a single statement. A terminal run
// (completed/failed/cancelled) matches nothing, so a re-driven job for a
// finished run is not resurrected.
//
// `running` stays in the WHERE, but no longer unconditionally. It used to be
// admitted outright because the queue's lock renewal made a re-claim mean
// "the previous worker crashed" — true with one worker, false with N, where the
// previous executor may simply have missed a renewal or be slow. So a `running`
// run is admitted only when its executor has gone silent for longer than the
// takeover window, measured on the database's clock. `count === 0` means a live
// executor holds it: the caller acks its job rather than nacking, because the
// work is being done, just not here.
export const claimRunForExecution = async (
  prisma: PrismaClient,
  runId: string,
): Promise<RunClaim> => {
  const token = randomUUID()
  // The CTE reads the pre-update snapshot, so `prior.status` is what the run
  // carried when the statement started — which is how the caller learns it is
  // taking a run over rather than starting one, and therefore whether to look
  // for a crash checkpoint.
  const rows = await prisma.$queryRaw<{ prior_status: RunStatus }[]>`
    WITH prior AS (SELECT id, status, executor_heartbeat_at FROM runs WHERE id = ${runId}::uuid)
    UPDATE runs
    SET status = 'running',
        started_at = now(),
        executor_token = ${token}::uuid,
        executor_heartbeat_at = now()
    FROM prior
    WHERE runs.id = prior.id
      AND (
        prior.status = 'pending'
        OR (
          prior.status = 'running'
          AND (
            prior.executor_heartbeat_at IS NULL
            OR prior.executor_heartbeat_at < now() - ${EXECUTOR_TAKEOVER_INTERVAL}::interval
          )
        )
      )
    RETURNING prior.status AS prior_status
  `
  const priorStatus = rows[0]?.prior_status
  if (rows.length !== 1 || !priorStatus) return { claimed: false, priorStatus: null, token: null }
  registerExecutorFence(runId, token)
  return { claimed: true, priorStatus, token }
}

export const setAgentStatus = async (
  prisma: PrismaClient,
  agentId: string,
  status: | 'idle'
    | 'thinking'
    | 'executing'
    | 'waiting_approval'
    | 'waiting_input'
    | 'error',
): Promise<void> => {
  await prisma.agent.update({
    where: { id: agentId },
    data: { status },
  })
}

// Reply-thread placement (#233): after a run-authored message is created with
// `rootMessageId`, update the root's materialized reply metadata in the same
// unit of work and return it for realtime fan-out. A bookkeeping failure
// propagates exactly like a message-create failure — no silent fallback.
export const applyRunReplyBookkeeping = async (
  prisma: PrismaClient,
  context: RunContext,
  replyCreatedAt: Date,
): Promise<ReplyPlacement | undefined> => {
  const rootMessageId = context.replyRootMessageId
  if (!rootMessageId) return undefined
  const meta = await applyReplyBookkeeping(prisma, {
    rootMessageId,
    replyCreatedAt,
    authorId: context.agent.id,
  })
  return { rootMessageId, meta }
}

export const loadRunContext = async (
  prisma: PrismaClient,
  payload: RunExecuteJobPayload,
): Promise<RunContext | null> => {
  const run = await prisma.run.findUnique({
    where: { id: payload.runId },
    include: {
      agent: {
        select: {
          agentKind: true,
          effort: true,
          executionMode: true,
          id: true,
          model: true,
          modelSubscriptionId: true,
          name: true,
          parentAgentId: true,
          ownerUserId: true,
          provider: true,
          // Optional explicit per-run caps; absent keys fall through to the
          // deployment backstop (see run-budget.ts).
          runLimits: true,
          speakingStyle: true,
          systemPrompt: true,
          systemSlug: true,
          visibility: true,
        },
      },
      thread: {
        select: {
          id: true,
          channel: {
            select: {
              id: true,
              organizationId: true,
              projectId: true,
              teamId: true,
              systemChannelType: true,
              dmKey: true,
            },
          },
        },
      },
      tasks: {
        where: { id: payload.taskId },
        select: { id: true },
        take: 1,
      },
      trigger: { select: { agentId: true, targetThreadId: true } },
    },
  })

  const task = run?.tasks[0]
  if (!run || !task) {
    return null
  }

  // One indexed lookup, cached on the context. The live stream gate calls the
  // disclosure predicate for every delta and must never perform IO itself.
  const [boundAgents, activeDemonstration, emailConversation] = await Promise.all([
    prisma.agentBinding.findMany({
      where: { channelId: run.thread.channel.id },
      select: { agentId: true },
    }),
    prisma.demonstration.findFirst({
      where: {
        agentId: run.agent.id,
        expiresAt: { gt: new Date() },
        organizationId: run.thread.channel.organizationId,
        status: 'recording',
        threadId: run.thread.id,
      },
      select: { id: true },
    }),
    // Cached with the context for the same reason as the bindings: the live
    // disclosure gate consults it per delta and must not perform IO. Non-null
    // only when this thread IS an email conversation's operations room, which
    // is what makes reading that correspondence unprivileged here.
    prisma.emailConversation.findUnique({
      where: { threadId: run.thread.id },
      select: { id: true, mailboxId: true },
    }),
  ])

  return {
    agent: { ...run.agent, runLimits: parseAgentRunLimits(run.agent.runLimits) },
    activeDemonstrationId: activeDemonstration?.id ?? null,
    boundAgentIds: boundAgents.map((binding) => binding.agentId),
    emailConversationId: emailConversation?.id ?? null,
    emailMailboxId: emailConversation?.mailboxId ?? null,
    channel: run.thread.channel,
    consumedSources: createConsumedSourceSink(),
    run: {
      id: run.id,
      principalUserId: run.principalUserId,
      threadId: run.thread.id,
      createdAt: run.createdAt,
      replyPlacement: run.replyPlacement,
      trigger: run.trigger,
    },
    task,
  }
}
