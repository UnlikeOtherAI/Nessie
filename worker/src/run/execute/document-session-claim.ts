import type { Prisma, PrismaClient, RunDocumentSessionStatus } from '@prisma/client'

/**
 * The claim every `run_document_sessions` write rides.
 *
 * ## Why the table needed one
 *
 * `runs.executor_token` fences the RUN, and the four session terminalisers —
 * the recorder's own `terminalize`, the failure path's `finalizeOutstanding`
 * (`document-stream.ts`), and the two save paths in
 * `pa-tools/knowledge-compose.ts` and `pa-tools/knowledge-edit.ts` — wrote the
 * session table directly, by id. So an executor fenced out of its run could
 * still write the session, and the two saves finished with an unconditional
 * `update` that would turn a status the reaper had written back into `saved`.
 *
 * ## The shape
 *
 * `run_document_sessions.claim_token` records which run execution opened the
 * session. A write is admitted only when BOTH halves hold, in one statement:
 *
 * - the session still carries the claim the writer opened it under, and
 * - `runs.executor_token` still equals that same claim.
 *
 * The second half is what makes it a cross-process fence: nothing on the session
 * row changes when a run is taken over, so identity alone would never notice.
 * It is the same fence `run/execute/crash-checkpoint.ts` writes for the same
 * reason, and the same property the queue's settle path buys with `(id,
 * attempt)`: a superseded writer matches no row. There, the successor bumps
 * `attempt`; here, the successor bumps `runs.executor_token` by claiming the
 * run, and the session's stored claim goes stale against it.
 *
 * ## What the fence is deliberately NOT
 *
 * It is **not** a check that the session is still open. Making the two saves
 * conditional on `status = 'saving'` looks like the same fix and is a different,
 * wrong one. `knowledge-compose.ts` compares the streamed text byte-for-byte
 * with the parsed arguments, stores the attachment and creates the page before
 * it writes the session: a save that reaches that write IS a complete document,
 * in the knowledge base, under a pageId the agent reports in chat. An executor
 * that was merely stalled — ten missed heartbeats against a database blip —
 * still holds its run, and its save must land on top of whatever the reaper
 * guessed in the meantime. In that scenario the lie is the reap, not the save,
 * so only a genuinely superseded writer is refused.
 *
 * ## What a superseded save leaves behind, and why nothing is deleted
 *
 * By the time a save is refused the attachment is stored and the page exists.
 * They are kept. Three reasons, in order of weight:
 *
 * 1. **The document is real.** It is the bytes the person watched arrive,
 *    verified against the model's own arguments. Deleting it destroys finished
 *    work on the strength of a lost race over a status column.
 * 2. **A fenced-out executor is the worst possible deleter.** It lost the run
 *    precisely because something about it went wrong, and by then the page may
 *    be published, labelled, filed against a ticket and indexed. Issuing
 *    deletes from there is a bigger failure than the one being fixed.
 * 3. **The ambiguity already has a home.** `run_tool_effects` claimed this tool
 *    call before it was dispatched, so the successor answers the call from that
 *    record rather than writing a second page, and the agent is told what
 *    happened instead of inventing it (`tool-effect-ledger.ts`).
 *
 * Nothing is orphaned in the product's sense either: the page is a `.md`
 * document in its knowledge space, with a title, a version and an attachment,
 * reachable by every route that reaches any other document. What is left wrong
 * is narrower and stated honestly — the popup's row for that session says the
 * run was lost while the document it describes exists. Repairing that row would
 * mean either letting the superseded executor write it (which is the defect) or
 * teaching the successor to adopt a predecessor's document window, which is a
 * product decision about what that window should say, not an engineering one.
 * Until it is taken, a refused save is reported at error level with the page it
 * left behind, so the two can be reconciled by hand.
 */

/** What a fenced write did. */
export type DocumentSessionSettleOutcome =
  /** The write landed. */
  | 'applied'
  /**
   * The claim is intact, but the session had already left the state this write
   * required — a save that has already won, or a session someone terminalized
   * first. An ordinary outcome; every caller has a branch for it.
   */
  | 'closed'
  /**
   * The claim is gone: this executor no longer holds the run, or no longer
   * holds the session. Never silent — it is reported before it is returned.
   */
  | 'superseded'

/**
 * Narrow store, so a test can drive the fence with an otherwise real database
 * (and so the reaper's store type stays as small as it is).
 */
export type DocumentSessionClaimStore = {
  runDocumentSession: Pick<PrismaClient['runDocumentSession'], 'findUnique' | 'updateMany'>
}

/**
 * The claim predicate on its own, for a caller that builds its own statement.
 *
 * With no claim token the write is unfenced beyond the session's own NULL
 * claim, which is the pre-claim behaviour preserved deliberately: a session
 * opened outside an executor claim has nothing to fence on, and inventing one
 * would only refuse writes that were always legitimate.
 */
export const documentSessionClaimWhere = (
  sessionId: string,
  claimToken: string | null,
): Prisma.RunDocumentSessionWhereInput => (
  claimToken === null
    ? { claimToken: null, id: sessionId }
    : { claimToken, id: sessionId, run: { executorToken: claimToken } }
)

export type DocumentSessionSettleInput = {
  /** The claim this writer opened the session under. */
  claimToken: string | null
  data: Prisma.RunDocumentSessionUpdateManyMutationInput
  /**
   * The statuses this write may act on, when it is a transition rather than the
   * record of a side effect that already happened. Omitted by the saves on
   * purpose — see the note on the cheap guard above.
   */
  from?: readonly RunDocumentSessionStatus[]
  sessionId: string
  /** Names this write in the refusal log. */
  settle: string
}

/**
 * One fenced session write.
 *
 * A refusal reports itself rather than passing silently, which is the half of
 * the queue's settle path that is easy to leave out: zero rows is not a no-op,
 * it is this process discovering that something it believed about the world
 * stopped being true while it was working. The two causes are told apart by
 * reading the row back, because only one of them is a problem.
 */
export const settleDocumentSession = async (
  prisma: DocumentSessionClaimStore,
  input: DocumentSessionSettleInput,
): Promise<DocumentSessionSettleOutcome> => {
  const { count } = await prisma.runDocumentSession.updateMany({
    data: input.data,
    where: {
      ...documentSessionClaimWhere(input.sessionId, input.claimToken),
      ...(input.from ? { status: { in: [...input.from] } } : {}),
    },
  })
  if (count > 0) return 'applied'

  const observed = await prisma.runDocumentSession
    .findUnique({
      select: { claimToken: true, run: { select: { executorToken: true } }, status: true },
      where: { id: input.sessionId },
    })
    .catch(() => null)

  const stillOurs = observed !== null
    && observed.claimToken === input.claimToken
    && (input.claimToken === null || observed.run.executorToken === input.claimToken)
  // The claim held, so the `from` predicate is what refused: an ordinary race
  // between two writers that are both entitled to be here.
  if (stillOurs) return 'closed'

  // Only a claim that moved says anything about concurrent execution, and the
  // difference between the two tokens is the whole diagnosis.
  const diagnosis = observed === null
    ? 'The row is gone — deleted with its run — so this write had nothing to act on.'
    : `The session is ${observed.status}, claimed by ${observed.claimToken ?? 'nobody'}, and its `
      + `run is held by ${observed.run.executorToken ?? 'nobody'} — so this executor was `
      + 'superseded and may have been writing the document alongside its successor.'
  console.error(
    `[worker] refused to ${input.settle} document session ${input.sessionId}: claimed under `
    + `${input.claimToken ?? 'no token'}. ${diagnosis}`,
  )
  return 'superseded'
}
