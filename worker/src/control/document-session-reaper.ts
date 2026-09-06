import { Prisma, type PrismaClient } from '@prisma/client'
import {
  parseRunId,
  type DocumentStreamErrorReason,
  type SseEvent,
} from '@nessie/schemas'

/**
 * Terminalize document sessions whose producer died.
 *
 * Every terminaliser for `run_document_sessions` is in-process: the recorder's
 * own `terminalize` (`run/execute/document-stream.ts`), the two save paths in
 * `run/pa-tools/knowledge-compose.ts` and `knowledge-edit.ts`, and the failure
 * path's `finalizeOutstanding`. All four run inside the worker that is writing
 * the document, so a `SIGKILL` — an autoscaler reclaiming a node, an OOM kill,
 * a host going away — leaves the row `streaming` and nothing outside that dead
 * process ever moves it. `api/src/services/document-streams.ts` counts
 * `streaming`/`saving` as active, so the admin shows a document that never
 * finishes and the reader waits on a stream nobody is producing (audit 2.5).
 * With N workers, dying mid-stream is routine rather than exceptional.
 *
 * ## What "abandoned" means here
 *
 * Not age. A legitimately long generation is indistinguishable from a dead one
 * by the clock alone, and reaping on age kills real documents. The signal is
 * the run's executor liveness, which the run-fencing work already made durable:
 * `claimRunForExecution` stamps `runs.executor_token` and
 * `runs.executor_heartbeat_at` in the claiming statement, and
 * `startExecutorHeartbeat` refreshes the heartbeat every 30 s for as long as
 * the execution lives (`run/execute/lifecycle.ts`).
 *
 * A stale heartbeat alone is NOT that signal, because the heartbeat is not a
 * liveness probe of the process — it is a liveness probe of a *claim*. The
 * interval body returns early on `fence.token === null` (`lifecycle.ts`), and
 * two ordinary, healthy events null that token:
 *
 * - **A run parks for a person.** `updateRunStatus` clears the token in the
 *   statement that writes `waiting_approval`/`waiting_input`, so the heartbeat
 *   falls silent the moment a run waits on an approval or a card. Six minutes
 *   is an ordinary length of time for a person to take.
 * - **A worker drains.** `releaseRunForDrain` nulls token *and* heartbeat by
 *   design, so the next worker claims the run on its next poll instead of
 *   waiting out the takeover window. The run stays `running` with its job back
 *   on the queue; under a scale-in, with every other worker busy, it can sit
 *   there for minutes before a successor picks it up.
 *
 * So the predicate is a claim about the RUN, and the heartbeat only dates it:
 *
 * - `running` **and** a heartbeat that exists and has been silent longer than
 *   the window — an executor started, stamped its claim, and stopped. NULL is
 *   deliberately not silence (`NULL < x` is not true, so the drained run above
 *   matches nothing): a null heartbeat means an orderly hand-back or a run not
 *   yet claimed, and in both cases an executor is *coming*, not gone.
 * - or terminal (`completed`/`failed`/`cancelled`) — `claimRunForExecution`
 *   admits only `pending` and stale `running` runs, so a terminal run will
 *   never be held again by anybody and an open session on it is stranded
 *   whatever its heartbeat says. This is the arm that collects what the first
 *   one waits out: the drained run's successor finishes, the run goes terminal,
 *   and any session its predecessor stranded is reaped then.
 *
 * A session is never reaped out of `pending`, `waiting_approval` or
 * `waiting_input`. A parked run's executor did not die — `executor_lost` would
 * be a lie told into the reader's open dialog about a document nobody has lost
 * — and every parked run eventually leaves that status (`resumeSuspendedRun`
 * terminalises it when the person answers, `sweepExpiredApprovals` when nobody
 * does, and cancelling flips all three of these statuses straight to
 * `cancelled`), at which point the terminal arm above collects anything it
 * stranded. In the ordinary flow there is nothing to
 * collect: `run-outcome.ts` calls `finalizeOutstanding` — 'approval_required'
 * or 'card_response' — BEFORE the suspension writes the status, so a parked run
 * has no open session unless that terminalising write itself failed.
 *
 * The session's own `updated_at` has to be as old too. That is a weak witness
 * on purpose — the durable lane writes chunk rows, not the session row, so a
 * long compose can sit untouched for minutes — and it is ANDed with the run
 * predicate rather than ORed, so all it can do is spare a session somebody has
 * just touched (a retarget from the popup's address bar lands on this column,
 * and a person retargeting a document is a person still waiting for it). It
 * cannot strand one: the next pass reaps it.
 *
 * ## Why five minutes
 *
 * The heartbeat is every 30 s and `claimRunForExecution` hands a `running` run
 * to another executor after two minutes of silence. Five is comfortably past
 * both: ten missed beats is not a garbage collection pause or a stalled event
 * loop, and — the load-bearing half — it is strictly *after* the point at which
 * the system has already declared the executor dead and let another worker take
 * the run over. Shorter than the takeover window would mean guessing ahead of
 * the run claim; much longer would just make the reader wait.
 *
 * A run that *was* taken over gets a fresh heartbeat, so the previous
 * executor's stranded session waits for the new execution to end before it is
 * reaped. That is bounded (the resumed run terminates) and deliberately
 * conservative: the resumed run writes its own session rows, and nothing is
 * gained by racing it.
 *
 * ## What this still cannot promise
 *
 * The reap is not a fence. `runs.executor_token` fences the RUN, and the four
 * session terminalisers write `run_document_sessions` directly — a table with
 * no claim column — so an executor that is merely stalled rather than dead (ten
 * lost heartbeats against a database blip, say) can wake after a reap and
 * write the session anyway: `knowledge-compose.ts` and `knowledge-edit.ts`
 * finish with an unconditional `update` by id and would turn `failed` back into
 * `saved`. Reaping later would not close that window, only move it. Closing it
 * means giving the session its own claim and making every terminaliser ride it,
 * which is a separate change with a design question of its own (what a
 * superseded executor should do about the page it has already written).
 * Recorded in the horizontal-scaling plan rather than pretended away here.
 */
export const DOCUMENT_SESSION_EXECUTOR_SILENCE_MS = 5 * 60_000

/**
 * The sweep's cluster-wide identity. Stable by contract: renaming it during a
 * rolling deploy is the same as taking no lock at all.
 */
export const DOCUMENT_SESSION_REAP_LOCK = 'document-session-reaper'

/** How often each worker offers to run the pass. Nothing depends on the cadence. */
export const DOCUMENT_SESSION_REAP_INTERVAL_MS = 60_000

/**
 * One pass reads at most this many sessions. The sweep runs on every worker on
 * an interval, so an unbounded read would let one bad day's backlog turn a
 * maintenance tick into a table scan the size of the incident.
 */
export const DOCUMENT_SESSION_REAP_BATCH_LIMIT = 50

/** What a reaped row says it died of, for the operator reading it later. */
export const DOCUMENT_SESSION_REAP_REASON: DocumentStreamErrorReason = 'executor_lost'

/** The two statuses a session can still be reaped out of. */
const OPEN_STATUSES = ['streaming', 'saving'] as const

type AbandonedRow = { id: string; run_id: string; thread_id: string }

/**
 * Narrow store, so a test can make exactly one row's write throw against an
 * otherwise real database.
 */
export type DocumentSessionReaperStore = Pick<PrismaClient, '$queryRaw'> & {
  runDocumentSession: Pick<PrismaClient['runDocumentSession'], 'updateMany'>
}

export type ReapAbandonedDocumentSessionsOptions = {
  limit?: number
  /**
   * Optional, because the reaper's contract is the row: a popup that is still
   * open learns from this, and one opened later learns from the API's list
   * either way. A publish failure therefore never un-reaps a session.
   */
  publishSse?: (
    threadId: string,
    event: SseEvent['event'],
    data: SseEvent['data'],
  ) => Promise<unknown>
  silenceMs?: number
}

export type ReapAbandonedDocumentSessionsResult = { reaped: number; scanned: number }

/**
 * One bounded pass. Safe to run twice — `withSweepLock` narrows that to almost
 * never, but the second runner of a lost lock would find every row already
 * terminal and change nothing, because each write is conditional on the session
 * still being open.
 */
export const reapAbandonedDocumentSessions = async (
  prisma: DocumentSessionReaperStore,
  options: ReapAbandonedDocumentSessionsOptions = {},
): Promise<ReapAbandonedDocumentSessionsResult> => {
  const silenceSeconds = (options.silenceMs ?? DOCUMENT_SESSION_EXECUTOR_SILENCE_MS) / 1000
  const limit = options.limit ?? DOCUMENT_SESSION_REAP_BATCH_LIMIT

  // Both intervals are measured on the database's clock: with N workers the
  // comparison would otherwise be between machines whose clocks drift.
  const rows = await prisma.$queryRaw<AbandonedRow[]>(Prisma.sql`
    SELECT s.id, s.run_id, s.thread_id
    FROM run_document_sessions s
    JOIN runs r ON r.id = s.run_id
    WHERE s.status IN ('streaming', 'saving')
      AND s.updated_at < now() - make_interval(secs => ${silenceSeconds}::double precision)
      AND (
        -- An executor claimed this run, stamped a heartbeat, and stopped. A
        -- NULL heartbeat is not silence and must not match here: it is what a
        -- draining worker leaves behind for its successor to claim, and what a
        -- run carries before it is claimed at all. Written as a comparison
        -- rather than a COALESCE precisely so NULL yields unknown, not true.
        (
          r.status = 'running'
          AND r.executor_heartbeat_at
                < now() - make_interval(secs => ${silenceSeconds}::double precision)
        )
        -- Or the run is over. claimRunForExecution admits only pending and
        -- stale running runs, so nothing will ever hold this one again and an
        -- open session on it is stranded by definition. This arm is what
        -- collects a session the arm above deliberately waited out.
        OR r.status IN ('completed', 'failed', 'cancelled')
      )
      -- pending, waiting_approval and waiting_input are absent on purpose: an
      -- executor is coming, or a person is deciding. See the header comment --
      -- neither is an executor that died.
    ORDER BY s.updated_at ASC
    LIMIT ${limit}
  `)

  let reaped = 0
  for (const row of rows) {
    // Per row, because the batch is ordered and bounded: a row that
    // deterministically throws is first again on the next pass, so without this
    // one poison row would wedge the sweep for every session behind it, for
    // ever.
    try {
      const updated = await prisma.runDocumentSession.updateMany({
        data: {
          errorReason: DOCUMENT_SESSION_REAP_REASON,
          finishedAt: new Date(),
          status: 'failed',
        },
        // Only a session that is still open: a save that landed between the
        // read above and this write has already won.
        where: { id: row.id, status: { in: [...OPEN_STATUSES] } },
      })
      if (updated.count === 0) continue
      reaped += 1
      // No document text on this event — only which session ended and why — so
      // it discloses nothing the in-process terminaliser does not already
      // publish on the same thread lane.
      await options.publishSse?.(row.thread_id, 'stream.document.error', {
        reason: DOCUMENT_SESSION_REAP_REASON,
        runId: parseRunId(row.run_id),
        sessionId: row.id,
      })
    } catch (error) {
      console.warn(
        '[worker.document-session-reaper] could not reap session',
        row.id,
        error,
      )
    }
  }

  return { reaped, scanned: rows.length }
}
