import type { PrismaClient } from '@prisma/client'
import { dispatchClaimedDraft } from '@nessie/workspace-admin'

/**
 * Dispatch email whose undo window has elapsed.
 *
 * The undo affordance only exists because the send is *held*, so this sweep is
 * what makes a held send eventually real. Without it a consented send would sit
 * in `sending` forever, which is worse than not offering undo at all.
 *
 * The claim lives inside `dispatchClaimedDraft`: it flips `sending` to
 * `dispatching` atomically BEFORE any Gmail call, so two worker replicas
 * ticking the same interval can never both send one email. It also reclaims a
 * row left `dispatching` by a worker that died mid-send once
 * `STALE_CLAIM_WINDOW_MS` has passed, so a dead worker cannot strand a draft.
 * The loser throws `DRAFT_NOT_SENDABLE` and is counted as failed — the
 * correct no-op for a row another replica owns.
 *
 * Each row is dispatched independently and a failure never stops the batch:
 * `dispatchClaimedDraft` already returns a failed row to `draft` so the person
 * keeps an affordance, and one provider error must not strand every other
 * person's mail behind it.
 */
export const sweepDueGmailSends = async (
  prisma: PrismaClient,
  deps: { encryptionSecret: string; now?: () => Date },
): Promise<{ dispatched: number; failed: number }> => {
  const now = deps.now?.() ?? new Date()
  const due = await prisma.gmailDraftAction.findMany({
    where: { state: 'sending', sendAfter: { lte: now } },
    select: { id: true },
    // Bounded so one very large backlog cannot monopolise a sweep tick.
    take: 50,
    orderBy: { sendAfter: 'asc' },
  })

  let dispatched = 0
  let failed = 0
  for (const row of due) {
    try {
      await dispatchClaimedDraft(prisma, row.id, deps)
      dispatched += 1
    } catch {
      // Already returned to `draft` by the dispatcher; count and continue.
      failed += 1
    }
  }
  return { dispatched, failed }
}
