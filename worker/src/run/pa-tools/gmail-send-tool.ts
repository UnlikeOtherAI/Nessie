import {
  hasStandingSendAuthorization,
  sendDraftForUser,
} from '@nessie/team-admin'
import { AuthorizedGmailDraftSendToolInputSchema } from '@nessie/runtime'

import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import {
  explainGoogleFailure,
  recordGoogleRead,
  resolveGoogleActingUserId,
} from './google-access.js'

/**
 * Send a draft as the requesting person.
 *
 * The approval gate itself is structural — `gmail_draft_send` carries
 * `requiresApproval` in its definition, so the tool chokepoint suspends the run
 * before this handler is ever reached unless the call is authorised. What this
 * file adds is the ONE way that gate is legitimately skipped: standing consent
 * the mailbox owner gave for this exact agent.
 *
 * The consent never removes the content check. An approved or consented send
 * still re-reads the live draft and refuses if its recipients or body changed.
 */

/** How long a consented send is held so the card can offer Undo. */
const UNDO_WINDOW_MS = Number(process.env.NESSIE_GMAIL_UNDO_WINDOW_MS ?? 15_000)

export const runGmailDraftSendTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = AuthorizedGmailDraftSendToolInputSchema.parse(input)
  const userId = resolveGoogleActingUserId(context)

  const draft = await context.prisma.gmailDraftAction.findFirst({
    where: {
      id: args.draftId,
      organizationId: context.channel.organizationId,
      ownerUserId: userId,
    },
    select: { id: true, connectionId: true, ownerUserId: true, state: true },
  })
  if (!draft) {
    throw new Error('I cannot find that draft.')
  }
  recordGoogleRead(context, draft.ownerUserId)

  const approvalProofClaimed =
    context.authorization?.approvalProofClaimedForTool === 'gmail_draft_send'
  const approvalProofPresented = Boolean(
    context.actorContext.approval?.approvalId || context.actorContext.approval?.approvalProof,
  )

  // A raw queue proof is only an untrusted handle. The dispatcher alone turns
  // it into this capability fact after exact verification and atomic claim.
  // Never let an invalid or replayed proof fall back to an otherwise-live
  // standing grant: a sealed continuation is still the action a person saw.
  if (approvalProofPresented && !approvalProofClaimed) {
    throw new Error('I need approval before sending that.')
  }

  // A non-approved call may rely on standing consent, but re-check it at the
  // moment of sending rather than trusting the earlier gate: it can be revoked
  // or expire while the run is in flight.
  const consented = approvalProofClaimed
    ? false
    : await hasStandingSendAuthorization(context.prisma, {
      organizationId: context.channel.organizationId,
      connectionId: draft.connectionId,
      agentId: context.agentId,
      requestingUserId: userId,
      interactive: context.actorContext.actionContext.purpose !== 'trigger',
    })
  if (!consented && !approvalProofClaimed) {
    throw new Error(
      'I need approval before sending that. The draft card in the chat has a '
        + 'Send button, or you can let me send on your behalf from '
        + '/settings/connections.',
    )
  }

  try {
    const result = await sendDraftForUser(
      context.prisma,
      {
        organizationId: context.channel.organizationId,
        userId,
        draftActionId: args.draftId,
        expectedFingerprint: args.approvalFingerprint,
        // Only a consented send is held: an explicitly approved one was just
        // confirmed by a person, so making them wait again adds nothing.
        ...(consented && UNDO_WINDOW_MS > 0
          ? { holdMs: UNDO_WINDOW_MS }
          : {}),
      },
      { encryptionSecret: process.env.NESSIE_AUTH_SECRET ?? '' },
    )
    return {
      inputSummary: `draftId=${args.draftId}`,
      outputPreview: JSON.stringify(
        result.status === 'held'
          ? {
              status: 'sending',
              undoUntil: result.sendAfter.toISOString(),
              note: 'Sending shortly; the chat card shows an Undo button until then.',
            }
          : { status: 'sent', messageId: result.sentMessageId },
      ),
      toolName: 'gmail_draft_send',
    }
  } catch (error) {
    return explainGoogleFailure(context, 'gmail.compose', userId, error)
  }
}
