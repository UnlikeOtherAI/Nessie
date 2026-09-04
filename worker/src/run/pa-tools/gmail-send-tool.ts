import { sendDraftForUser } from '@nessie/team-admin'
import { z } from 'zod'

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

const SendSchema = z.object({
  connectionId: z.string().uuid().optional(),
  draftId: z.string().uuid(),
  expectedFingerprint: z.string().min(1).optional(),
}).strict()

/** How long a consented send is held so Mail can offer Undo. */
const UNDO_WINDOW_MS = Number(process.env.NESSIE_GMAIL_UNDO_WINDOW_MS ?? 15_000)

export const runGmailDraftSendTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = SendSchema.parse(input)
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

  // The chokepoint supplies this after it resolved the exact standing grant or
  // judged boundary. A handler must not reinterpret that decision differently.
  const consented = context.gmailDraftSendStandingAuthorized === true
  // The authorizer installs this execution-only capability after its one-time
  // proof CAS succeeds. A resumed payload's raw token is not authority here.
  const approved = context.gmailDraftSendApproved === true
  if (approved && (!args.connectionId || !args.expectedFingerprint)) {
    throw new Error('This approval is not bound to the reviewed Gmail draft.')
  }
  if (args.connectionId && args.connectionId !== draft.connectionId) {
    throw new Error('This approval is not bound to this Gmail connection.')
  }
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
        ...(args.expectedFingerprint ? { expectedFingerprint: args.expectedFingerprint } : {}),
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
