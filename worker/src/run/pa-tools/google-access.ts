import { Prisma } from '@prisma/client'
import { parseChannelId, parseThreadId } from '@nessie/schemas'
import type { GoogleCapabilityId } from '@nessie/schemas'
import { GmailDraftError } from '@nessie/workspace-admin'

import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import { buildRealtimeScopesForChannel } from './message-destination.js'
import { resolveEffectiveUserId } from './access.js'

/**
 * Shared plumbing for every Gmail and Calendar tool: who the call acts as, how
 * a missing permission becomes an in-chat request rather than a dead end, and
 * how a read is recorded so the reply cannot launder private mail into a
 * shared room.
 */

/**
 * The person a Google tool acts as.
 *
 * This is `effectiveUserId` in both cases, and deliberately so: an interactive
 * run carries the requester, and a scheduled run already carries its trigger's
 * captured launch-origin user (`trigger-run.ts` sets it from
 * `executionOrigin.userId`), which brings the verifiable identity and the
 * owner-revocation gate with it. So a schedule can read its owner's mailbox —
 * which is what makes "summarise my inbox each morning" work — while writes
 * stay gated separately, and an unattended send still has to be approved.
 */
export const resolveGoogleActingUserId = (
  context: BuiltinToolRuntimeContext,
): string => {
  const userId = resolveEffectiveUserId(context)
  if (!userId) {
    throw new Error(
      'I can only reach your Google account when a person asks me directly, '
        + 'or on a schedule somebody set up under their own account.',
    )
  }
  return userId
}

/**
 * Record that this run consumed the mailbox owner's private material.
 *
 * The obligation sits on the READ, in the same change as the read: an empty
 * basis means unrestricted, so a read path that forgets this publishes a
 * person's inbox to whoever can see the destination. The consequence is
 * intended — an agent that read your mail and answers in a channel produces a
 * reply only you can see, with the existing one-click share affordance.
 */
export const recordGoogleRead = (
  context: BuiltinToolRuntimeContext,
  ownerUserId: string,
): void => {
  context.consumedSources?.add({ scopeType: 'user', scopeId: ownerUserId })
}

const CAPABILITY_ASK: Record<GoogleCapabilityId, string> = {
  'gmail.read': 'read your email',
  'gmail.compose': 'write drafts and send email as you',
  'gmail.send': 'send email as you',
  'gmail.modify': 'organise your email',
  'calendar.read': 'read your calendar',
  'calendar.freebusy': 'see when you are free',
  'calendar.write': 'manage your calendar events',
  'meet.create': 'create Google Meet links',
  'contacts.read': 'look up your contacts',
}

/**
 * Post the in-chat permission request and return the words the model should
 * say. This is what makes a missing scope recoverable inside the conversation
 * instead of a refusal the person cannot act on.
 *
 * The card is server-authored — the capability id comes from the tool that
 * failed, never from model output — and it carries the mailbox owner's basis
 * explicitly. A card can be posted before any read has happened, so relying on
 * the run's accumulated basis would leave it unrestricted and leak the owner's
 * identity and the fact of the request into a shared room.
 */
export const requestGoogleCapability = async (
  context: BuiltinToolRuntimeContext,
  capabilityId: GoogleCapabilityId,
  ownerUserId: string,
): Promise<string> => {
  recordGoogleRead(context, ownerUserId)
  const threadId = context.run.threadId
  const thread = await context.prisma.thread.findUnique({
    where: { id: threadId },
    select: { channel: { select: { id: true, systemChannelType: true } } },
  })
  if (!thread) {
    return `I need permission to ${CAPABILITY_ASK[capabilityId]}. `
      + 'Open /settings/connections to grant it.'
  }
  const content =
    `I need permission to ${CAPABILITY_ASK[capabilityId]} before I can do that.`
  const message = await context.prisma.message.create({
    data: {
      content,
      role: 'assistant',
      agentId: context.agentId,
      threadId: parseThreadId(threadId),
      metadata: {
        card: { kind: 'google_scope_request', capabilityId },
      } as Prisma.InputJsonValue,
    },
    select: { id: true },
  })
  await context.realtimeTransport.publishWs(
    buildRealtimeScopesForChannel({
      channelId: thread.channel.id,
      organizationId: context.channel.organizationId,
      systemChannelType: thread.channel.systemChannelType,
    }),
    {
      data: {
        agentId: context.agentId,
        channelId: parseChannelId(thread.channel.id),
        contentPreview: content.slice(0, 200),
        messageId: message.id,
        role: 'assistant',
        threadId: parseThreadId(threadId),
      },
      event: 'message.new',
    },
  )
  return `${content} I have put a Grant button in the chat.`
}

/**
 * Turn a credential or draft failure into words a person can act on, raising
 * the in-chat grant card when the remedy is a permission.
 */
export const explainGoogleFailure = async (
  context: BuiltinToolRuntimeContext,
  capabilityId: GoogleCapabilityId,
  ownerUserId: string,
  error: unknown,
): Promise<never> => {
  const code = error instanceof GmailDraftError ? error.code : undefined
  if (code === 'SCOPE_MISSING' || code === 'GOOGLE_NOT_CONNECTED') {
    throw new Error(await requestGoogleCapability(context, capabilityId, ownerUserId))
  }
  if (code === 'CAPABILITY_BLOCKED') {
    throw new Error(
      `You have switched off "${CAPABILITY_ASK[capabilityId]}" for this account. `
        + 'Turn it back on at /settings/connections and ask me again.',
    )
  }
  if (code === 'NEEDS_REAUTHORIZATION') {
    throw new Error(
      'Your Google connection needs reauthorizing. Open /settings/connections '
        + 'and reconnect, then ask me again.',
    )
  }
  if (code === 'AMBIGUOUS_ACCOUNT') {
    throw new Error(
      'You have more than one Google account connected. Tell me which address '
        + 'to use, or disconnect the one you do not want at /settings/connections.',
    )
  }
  if (code === 'DRAFT_CHANGED') {
    throw new Error(
      'That draft changed since it was approved, so I did not send it. Ask me '
        + 'to send it again and the person will be asked to confirm the new text.',
    )
  }
  if (code === 'DRAFT_NOT_SENDABLE') {
    throw new Error('That draft has already been sent or is being sent.')
  }
  if (code === 'DRAFT_NOT_FOUND') {
    throw new Error('I cannot find that draft.')
  }
  throw error instanceof Error ? error : new Error('Google request failed.')
}
