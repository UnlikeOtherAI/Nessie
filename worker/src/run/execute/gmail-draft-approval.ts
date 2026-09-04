import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

/**
 * The model authorizes a draft handle, but the handle is mutable. Bind an
 * approval to the server-owned content fingerprint before policy, audit, or
 * approval persistence. A continuation recomputes it, invalidating a proof
 * when a card, Gmail, or another run changed the draft.
 */
export const bindGmailDraftApprovalFingerprint = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  organizationId: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | null> => {
  const ownerUserId = actorContext.actionContext.effectiveUserId
    ?? (actorContext.actor.actorType === 'user' ? actorContext.actor.actorId : null)
  const draft = ownerUserId
    ? await prisma.gmailDraftAction.findFirst({
      where: {
        id: args.draftId as string,
        organizationId,
        ownerUserId,
      },
      select: { contentFingerprint: true },
    })
    : null
  return draft ? { ...args, approvalFingerprint: draft.contentFingerprint } : null
}
