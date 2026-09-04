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
import { mailPresentationReference } from './mail-presentation-reference.js'

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

/** How long a consented send is held so Mail can offer Undo. */
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

  // A run that reached here without an approval proof is relying on standing
  // consent. Re-check it at the moment of sending rather than trusting the
  // gate's earlier decision: a grant can be revoked or expire mid-run.
  const consented = await hasStandingSendAuthorization(context.prisma, {
    organizationId: context.channel.organizationId,
    connectionId: draft.connectionId,
    agentId: context.agentId,
    requestingUserId: userId,
    interactive: context.actorContext.actionContext.purpose !== 'trigger',
  })
  const approved = Boolean(context.actorContext.approval?.approvalProof)
  if (!consented && !approved) {
    throw new Error(
        'I need approval before sending that. Open the draft in Mail and use '
        + 'its Send button, or let me send on your behalf from '
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
        ...(consented && !approved && UNDO_WINDOW_MS > 0
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
              mailPresentation: mailPresentationReference({
                accountId: draft.connectionId,
                mode: 'account',
                source: 'gmail',
              }),
              status: 'sending',
              undoUntil: result.sendAfter.toISOString(),
              note: 'Sending shortly; Mail shows an Undo button until then.',
            }
          : {
              mailPresentation: mailPresentationReference({
                accountId: draft.connectionId,
                mode: 'account',
                source: 'gmail',
              }),
              messageId: result.sentMessageId,
              status: 'sent',
            },
      ),
      toolName: 'gmail_draft_send',
    }
  } catch (error) {
    return explainGoogleFailure(context, 'gmail.compose', userId, error)
  }
}
