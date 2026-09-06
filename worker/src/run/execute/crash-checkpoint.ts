import { Prisma, type PrismaClient } from '@prisma/client'

import type { LoopResumeState } from '../loop-resume.js'

// The third kind of checkpoint (horizontal scaling, phase 3.1).
//
// The other two are affordances a person acts on: a budget stop and an approval
// suspension leave a model-written note, and someone presses Continue. This one
// is machine state, written continuously while the run is healthy so that a run
// whose worker dies is resumed IN PLACE — same run id, same transcript, same
// spend — instead of being re-executed from the prompt with every tool it
// already ran running a second time and every inference billed again.
//
// It rides on `run_checkpoints` rather than a table of its own: `run_id` is
// already unique there, which is exactly the one-row-per-run invariant this
// needs, and the two kinds never collide because they occupy different columns.
// A row that only ever carried crash state has `reason = 'crash'` and an empty
// note; a later budget stop or suspension overwrites `reason`/`note` in place
// and the row becomes continuable. `loadRunCheckpointForRun` skips the former,
// so a crash checkpoint is never injected into another run as "working notes".
//
// See docs/standards/tech-and-run-budgets.md and
// docs/standards/horizontal-scaling.md invariant 4.

export const CRASH_CHECKPOINT_REASON = 'crash'

/**
 * Above this, the state is not written at all.
 *
 * A transcript carrying inlined images (base64 in a `user` turn) can reach many
 * megabytes, and rewriting that at every iteration boundary would cost more
 * than the replay it prevents. Skipping degrades the run to today's behaviour —
 * re-execution from the prompt — which is a known outcome rather than a new
 * failure, and the log line says which run it happened to.
 */
export const MAX_CRASH_STATE_BYTES = 4_000_000

const serializeState = (state: LoopResumeState): string | null => {
  const encoded = JSON.stringify(state)
  return encoded.length > MAX_CRASH_STATE_BYTES ? null : encoded
}

export type CrashCheckpointTarget = {
  agentId: string
  organizationId: string
  rootMessageId: string | null
  runId: string
  taskId: string
  threadId: string
}

/**
 * Write (or overwrite) this run's crash state, fenced on the executor token.
 *
 * The fence is the run row itself, not the checkpoint row: the statement only
 * proposes a row when `runs.executor_token` still equals the token this
 * execution claimed with, so an executor that has been taken over affects zero
 * rows instead of clobbering the live one's state. Returns the rows written —
 * `0` means fenced out (or the run is gone), never an error.
 *
 * The fence has to hold on the UPDATE half too, and a plain `WHERE` on the
 * `SELECT` does not give it: under READ COMMITTED this statement's snapshot is
 * taken once, so an executor could read `executor_token = me`, lose the run to
 * a takeover, and still have its `ON CONFLICT DO UPDATE` overwrite the new
 * holder's fresher state — stamping the row with the superseded token. The
 * locking CTE closes that: `FOR NO KEY UPDATE` conflicts with the row lock a
 * takeover's `UPDATE runs SET executor_token = …` takes, so either
 *
 *   - this statement locks first, and the takeover waits until the whole
 *     insert-or-update has committed — the write really did happen while we
 *     held the run; or
 *   - the takeover commits first, and the lock wait re-reads the new row
 *     version, no longer matching our token, so `held` is empty, nothing is
 *     proposed, no conflict arises and `DO UPDATE` never runs.
 *
 * There is no interleaving in between, which is what makes the conflict path
 * reachable only by the executor that holds the run.
 */
export const persistCrashCheckpoint = async (
  prisma: PrismaClient,
  target: CrashCheckpointTarget,
  executorToken: string,
  state: LoopResumeState,
): Promise<number> => {
  const encoded = serializeState(state)
  if (encoded === null) {
    console.warn(
      `[worker] run ${target.runId} crash state exceeds ${MAX_CRASH_STATE_BYTES} bytes; `
      + 'not checkpointed — a re-claim will replay this run from the prompt',
    )
    return 0
  }
  return prisma.$executeRaw`
    WITH held AS (
      SELECT r.id
      FROM runs r
      WHERE r.id = ${target.runId}::uuid AND r.executor_token = ${executorToken}::uuid
      FOR NO KEY UPDATE
    )
    INSERT INTO run_checkpoints (
      id, organization_id, run_id, task_id, agent_id, thread_id, root_message_id,
      generation, reason, note, crash_state, crash_executor_token, crash_updated_at,
      created_at
    )
    SELECT
      gen_random_uuid(), ${target.organizationId}::uuid, ${target.runId}::uuid,
      ${target.taskId}::uuid, ${target.agentId}::uuid, ${target.threadId}::uuid,
      ${target.rootMessageId}::uuid, 1, ${CRASH_CHECKPOINT_REASON}, '',
      ${encoded}::jsonb, ${executorToken}::uuid, now(), now()
    FROM held
    ON CONFLICT (run_id) DO UPDATE
    SET crash_state = EXCLUDED.crash_state,
        crash_executor_token = EXCLUDED.crash_executor_token,
        crash_updated_at = now()
  `
}

/**
 * The crash state this run left behind, or null when it has none.
 *
 * Null is the ordinary case — a run starting from its prompt — and the caller
 * says so in a log line rather than treating it as a fault.
 */
export const loadCrashCheckpoint = async (
  prisma: PrismaClient,
  runId: string,
): Promise<LoopResumeState | null> => {
  const row = await prisma.runCheckpoint.findUnique({
    select: { crashState: true },
    where: { runId },
  })
  const raw = row?.crashState
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  // A shape check rather than a schema: the only writer is the loop in this
  // same deploy, so the one thing worth guarding against is a row written by an
  // older shape. A transcript that is not an array cannot be resumed from, and
  // starting from the prompt is the correct — and already-implemented —
  // fallback for having no checkpoint at all.
  const state = raw as unknown as LoopResumeState
  if (!Array.isArray(state.messages) || typeof state.iterations !== 'number') {
    console.warn(`[worker] run ${runId} has an unreadable crash checkpoint; ignoring it`)
    return null
  }
  return state
}

/**
 * Drop the crash state, fenced on the executor token. Fused to the run's status
 * chokepoint (`updateRunStatus`), so every terminal and suspended transition
 * sheds it without any one path having to remember: a finished run has nothing
 * to resume, and a parked one is resumed by a new run through its checkpoint
 * note, never in place.
 *
 * A row that carries ONLY crash state goes entirely; one a budget stop or a
 * suspension has since written its note into keeps everything but the crash
 * columns, because that note is somebody's Continue button.
 *
 * The fence is two-sided because either side alone is wrong. `crash_executor_
 * token = us` covers the suspension path, where `updateRunStatus` has already
 * released `runs.executor_token` in the same statement that parked the run, so
 * the run row no longer names us — but the state on the row is still ours to
 * shed. `runs.executor_token = us` covers a run we hold whose row carries a
 * previous executor's state (we took it over and finished before our first
 * boundary write). A superseded executor satisfies neither, so it cannot erase
 * the live executor's checkpoint and force a replay from the prompt.
 */
export const clearCrashCheckpoint = async (
  prisma: PrismaClient,
  runId: string,
  executorToken: string,
): Promise<void> => {
  await prisma.$executeRaw`
    DELETE FROM run_checkpoints c
    WHERE c.run_id = ${runId}::uuid
      AND c.reason = ${CRASH_CHECKPOINT_REASON}
      AND (
        c.crash_executor_token = ${executorToken}::uuid
        OR EXISTS (
          SELECT 1 FROM runs r
          WHERE r.id = ${runId}::uuid AND r.executor_token = ${executorToken}::uuid
        )
      )
  `
  await prisma.$executeRaw`
    UPDATE run_checkpoints c
    SET crash_state = NULL, crash_executor_token = NULL, crash_updated_at = NULL
    WHERE c.run_id = ${runId}::uuid
      AND c.crash_state IS NOT NULL
      AND (
        c.crash_executor_token = ${executorToken}::uuid
        OR EXISTS (
          SELECT 1 FROM runs r
          WHERE r.id = ${runId}::uuid AND r.executor_token = ${executorToken}::uuid
        )
      )
  `
}

/**
 * The same clear, for a caller that holds no executor token at all.
 *
 * There is exactly one: `updateRunStatus` writing a status from outside a run
 * execution — the quiet PA-presence cancellation, a status written before the
 * claim, a test. It is safe unfenced because it is not a competing executor: it
 * is the authority that is *ending* the run, and the status it writes in the
 * same breath (cancelled/failed) is what stops whoever is executing it. Leaving
 * the crash state behind there would be the bug — a cancelled run holding a
 * resumable snapshot.
 *
 * Anything that runs inside an execution must use `clearCrashCheckpoint` and
 * pass its token; this function is deliberately named so that using it by
 * accident reads wrong.
 */
export const clearCrashCheckpointForUnheldRun = async (
  prisma: PrismaClient,
  runId: string,
): Promise<void> => {
  await prisma.runCheckpoint.deleteMany({
    where: { reason: CRASH_CHECKPOINT_REASON, runId },
  })
  await prisma.$executeRaw`
    UPDATE run_checkpoints
    SET crash_state = NULL, crash_executor_token = NULL, crash_updated_at = NULL
    WHERE run_id = ${runId}::uuid AND crash_state IS NOT NULL
  `
}

export type CrashCheckpointWriter = {
  /**
   * True only when this state is durable. False is every other outcome — the
   * state was too big to write, the write failed, this execution has no token,
   * or it was fenced out — and none of them may be read as a successful
   * checkpoint: what follows a `false` is a replay from the prompt if the
   * worker dies now.
   */
  write: (state: LoopResumeState) => Promise<boolean>
}

/**
 * The loop's `onCheckpoint` sink.
 *
 * Error-swallowing by construction: a checkpoint is insurance, and a failed
 * write must never turn a healthy run into a failed one. It writes nothing when
 * this execution holds no fencing token — there is no run to be fenced to.
 *
 * A fenced-out write (zero rows) is reported as a failure rather than as a
 * quiet success, and said out loud once: from that point this execution's state
 * is not the run's state, and the run belongs to whoever took it over. The loop
 * finds that out for itself at its next per-iteration probe and stops; the log
 * line is what makes the ordering legible afterwards.
 */
export const createCrashCheckpointWriter = (
  prisma: PrismaClient,
  target: CrashCheckpointTarget,
  executorToken: string | null,
): CrashCheckpointWriter => {
  let announcedFenceOut = false
  return {
    write: async (state) => {
      if (!executorToken) return false
      try {
        const written = await persistCrashCheckpoint(prisma, target, executorToken, state)
        if (written === 0 && !announcedFenceOut) {
          announcedFenceOut = true
          console.warn(
            `[worker] crash checkpoint for run ${target.runId} matched no run held by this `
            + 'executor; it has been taken over (or deleted) and its state is no longer ours to write',
          )
        }
        return written > 0
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
          // The run or its task is gone (cascade delete mid-run). Nothing to
          // resume, and nothing worth a stack trace.
          return false
        }
        console.warn('[worker] could not write crash checkpoint for run', target.runId, error)
        return false
      }
    },
  }
}
