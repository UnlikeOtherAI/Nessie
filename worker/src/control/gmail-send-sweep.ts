import type { PrismaClient } from '@prisma/client'
import { writeAuditEntry } from '@nessie/db'
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
 * one provider error must not strand every other person's mail behind it. A
 * provider outcome we cannot prove is audited as unknown, never asserted as a
 * failed delivery.
 */
export const writeGmailDraftDispatchAudit = async (
  prisma: PrismaClient,
  input: { action: 'gmail.draft.sent' | 'gmail.draft.delivery_unknown'; id: string; organizationId: string },
  writer: typeof writeAuditEntry = writeAuditEntry,
): Promise<void> => {
  try {
    await writer(prisma, {
      action: input.action,
      actorId: 'gmail-draft-dispatch',
      actorType: 'system',
      metadata: { status: input.action === 'gmail.draft.sent' ? 'sent' : 'delivery_unknown' },
      organizationId: input.organizationId,
      outcome: input.action === 'gmail.draft.sent' ? 'success' : 'error',
      requestId: `gmail-draft-dispatch:${input.id}`,
      resourceId: input.id,
      resourceType: 'gmail_draft_action',
    })
  } catch {
    // The provider state is already durable. An audit outage cannot retry or
    // roll back a send, and must not prevent later rows from dispatching.
    console.error('[worker.gmail-send-sweep] failed to write audit transition')
  }
}

export const sweepDueGmailSends = async (
  prisma: PrismaClient,
  deps: { encryptionSecret: string; now?: () => Date },
): Promise<{ dispatched: number; failed: number; deliveryUnknown: number }> => {
  const now = deps.now?.() ?? new Date()
  const staleDeliveryUnknown = await resolveStaleGmailDispatches(prisma, { now: () => now })
  for (const row of staleDeliveryUnknown) {
    await writeGmailDraftDispatchAudit(prisma, {
      action: 'gmail.draft.delivery_unknown', id: row.id, organizationId: row.organizationId,
    })
  }
  const due = await prisma.gmailDraftAction.findMany({
    where: { state: 'sending', sendAfter: { lte: now } },
    select: { id: true, organizationId: true },
    // Bounded so one very large backlog cannot monopolise a sweep tick.
    take: 50,
    orderBy: { sendAfter: 'asc' },
  })

  let dispatched = 0
  let failed = 0
  for (const row of due) {
    try {
      await dispatchClaimedDraft(prisma, row.id, deps)
      await writeGmailDraftDispatchAudit(prisma, {
        action: 'gmail.draft.sent', id: row.id, organizationId: row.organizationId,
      })
      dispatched += 1
    } catch {
      const action = await prisma.gmailDraftAction.findUnique({
        where: { id: row.id }, select: { state: true },
      })
      if (action?.state === 'delivery_unknown') {
        await writeGmailDraftDispatchAudit(prisma, {
          action: 'gmail.draft.delivery_unknown', id: row.id, organizationId: row.organizationId,
        })
      }
      // The dispatcher either returned this row to draft before any provider
      // request, or made an explicitly unknown terminal outcome. Count and continue.
      failed += 1
    }
  }
  return { dispatched, failed, deliveryUnknown: staleDeliveryUnknown.length }
}
