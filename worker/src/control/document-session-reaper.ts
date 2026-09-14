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
 * by the clock alone, and reaping on age kills real documents. The question this
 * sweep asks is about the session's own claim
 * (`run/execute/document-session-claim.ts`): **is the claim this session was
 * opened under still live?** A live claim is refused; only a session no writer
 * can still be holding is reaped.
 *
 * A claim is live when both halves of it are:
 *
 * - `run_document_sessions.claim_token` still equals `runs.executor_token`, so
 *   the execution that opened the session still holds the run, **and**
 * - that execution is still beating — `runs.status = 'running'` with an
 *   `executor_heartbeat_at` inside the window below.
 *
 * The first half is what the claim column bought. Without it a session stranded
 * by an executor that was *superseded* — the run taken over, the successor
 * heartbeating happily — looked alive, and waited for the whole resumed run to
 * finish before anything collected it. Its claimant is fenced out of every write
 * it could still make (`document-session-claim.ts`), so there is nothing to wait
 * for. Nothing else fills that gap: the run row says "running, beating", and
 * only the session's own claim says which execution that is.
 *
 * The second half is the run-fencing work's own liveness signal:
 * `claimRunForExecution` stamps `runs.executor_token` and
 * `runs.executor_heartbeat_at` in the claiming statement, and
 * `startExecutorHeartbeat` refreshes the heartbeat every 30 s for as long as the
 * execution lives (`run/execute/lifecycle.ts`).
 *
 * ## A dead claim is still not enough: two states where an executor is coming
 *
 * A claim being dead does not by itself mean nobody will write the session,
 * because the heartbeat is not a liveness probe of a *process* — it is a
 * liveness probe of a claim. The interval body returns early on
 * `fence.token === null` (`lifecycle.ts`), and two ordinary, healthy events null
 * that token: in both, the claim reads dead while a writer is on its way. So
 * they are excluded explicitly, and the exclusions are the reason this predicate
 * is not simply `NOT live`.
 *
 * - **A run parks for a person.** `updateRunStatus` clears the token in the
 *   statement that writes `waiting_approval`/`waiting_input`, so the heartbeat
 *   falls silent the moment a run waits on an approval or a card. Six minutes
 *   is an ordinary length of time for a person to take.
 * - **A worker retries.** `handBackRunExecution` nulls token *and* heartbeat by
 *   design, so the next worker claims the run on its next poll instead of
 *   waiting out the takeover window. The run stays `running` with its job back
 *   on the queue; under a scale-in, with every other worker busy, it can sit
 *   there for minutes before a successor picks it up.
 *
 * So a session is reaped when its claim is not live **and** neither of those two
 * states holds. Written out, that is:
 *
 * - the claim was superseded — the run is held by a different execution than
 *   the one that opened this session. No heartbeat rescues it: its claimant
 *   cannot write the session again whatever it does next.
 * - or the claimant still holds the run but has been silent longer than the
 *   window — an executor started, stamped its claim, and stopped. A NULL
 *   heartbeat is deliberately not silence (`NULL < x` is not true, so the
 *   drained run above matches nothing): it means an orderly hand-back or a run
 *   not yet claimed, and in both cases an executor is *coming*, not gone.
 * - or the run is terminal (`completed`/`failed`/`cancelled`) —
 *   `claimRunForExecution` admits only `pending` and stale `running` runs, so a
 *   terminal run will never be held again by anybody and an open session on it
 *   is stranded whatever its heartbeat says. This is the arm that collects what
 *   the second one waits out: the drained run's successor finishes, the run
 *   goes terminal, and any session its predecessor stranded is reaped then.
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
 * A run that *was* taken over used to make the window meaningless from the other
 * direction: the successor's fresh heartbeat made the predecessor's stranded
 * session look alive, so it waited out the whole resumed run. The claim is what
 * ended that wait — a superseded session is reaped on the first pass past its
 * `updated_at` window, because being superseded is not a timing question.
 *
 * ## The reap is a report, not a fence, and that is on purpose
 *
 * An executor that is merely stalled rather than dead — ten lost heartbeats
 * against a database blip — still holds its run, so its claim is still live and
 * every write it makes is still admitted. It can therefore wake up after a reap
 * and write `saved` over the `failed` this sweep wrote, and it should: by then
 * the document is in the knowledge base with a pageId the agent reports in chat,
 * so the stale statement is the reap, not the save. That is why the reap does
 * NOT take the claim, and why the two save paths are fenced on the claim alone
 * and never on the status — the full argument is in
 * `run/execute/document-session-claim.ts`.
 *
 * What the reap does promise is that a session no live claim covers stops being
 * counted as active, and says why.
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
      -- The session's claim is not live. Live is both halves at once: the
      -- execution that opened this session still holds the run, AND that
      -- execution is still beating. A NULL claim_token is a session opened
      -- outside an executor claim — or written by a build older than the column
      -- — so it has no identity half to fail and is judged on the heartbeat
      -- alone, exactly as it was before the claim existed.
      --
      -- The identity half is what the claim bought: a session stranded by a
      -- SUPERSEDED executor sits on a run that is 'running' and beating (its
      -- successor's beat), so nothing in the run row alone could tell it apart
      -- from a document being written right now.
      AND NOT (
        (s.claim_token IS NULL OR s.claim_token = r.executor_token)
        AND r.status = 'running'
        AND r.executor_heartbeat_at
              > now() - make_interval(secs => ${silenceSeconds}::double precision)
      )
      -- ...and no executor is on its way. A dead claim is not by itself an
      -- abandoned session: the two states below null the run's token as part of
      -- being healthy, so the claim reads dead while a writer is still coming.
      -- They are named rather than derived for exactly that reason.
      --
      -- pending / waiting_approval / waiting_input: an executor is coming, or a
      -- person is deciding. executor_lost would be a lie in both, and every
      -- one of these statuses is left eventually — the terminal case below
      -- collects whatever they stranded.
      AND r.status NOT IN ('pending', 'waiting_approval', 'waiting_input')
      -- A 'running' run with a NULL heartbeat is what handBackRunExecution leaves
      -- for its successor to claim on its very next poll. Written as an explicit
      -- exclusion because NULL is not silence and must never read as it.
      AND NOT (r.status = 'running' AND r.executor_heartbeat_at IS NULL)
      -- Everything else reaches here: a claimant that stopped beating, a claim
      -- superseded by a takeover, and any open session on a terminal run —
      -- claimRunForExecution admits only pending and stale running runs, so
      -- nothing will ever hold that one again.
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
