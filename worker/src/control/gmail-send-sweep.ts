import type { PrismaClient } from '@prisma/client'
import { dispatchClaimedDraft, resolveStaleGmailDispatches } from '@nessie/team-admin'

/**
 * Dispatch email whose undo window has elapsed.
 *
 * The undo affordance only exists because the send is *held*, so this sweep is
 * what makes a held send eventually real. Without it a consented send would sit
 * in `sending` forever, which is worse than not offering undo at all.
 *
 * The claim lives inside `dispatchClaimedDraft`: it flips `sending` to
 * `dispatching` atomically BEFORE any Gmail call, so two worker replicas
 * ticking the same interval can never both send one email. A worker that dies
 * after starting Gmail's request is marked `delivery_unknown`, not reclaimed:
 * a lost response is not evidence that Gmail did not accept the message.
 *
 * Each row is dispatched independently and a failure never stops the batch:
 * one provider error must not strand every other person's mail behind it.
 */
export const sweepDueGmailSends = async (
  prisma: PrismaClient,
  deps: { encryptionSecret: string; now?: () => Date },
): Promise<{ dispatched: number; failed: number; deliveryUnknown: number }> => {
  const now = deps.now?.() ?? new Date()
  const deliveryUnknown = await resolveStaleGmailDispatches(prisma, { now: () => now })
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
  return { dispatched, failed, deliveryUnknown }
}
