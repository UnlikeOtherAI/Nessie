import { Prisma } from '@prisma/client'
import { getGoogleCapability, parseChannelId, parseThreadId } from '@nessie/schemas'
import {
  getGmailMessage,
  getGmailThread,
  searchGmailThreads,
} from '@nessie/comms-google'
import {
  attachDraftMessage,
  composeDraftForUser,
  loadUserGoogleCommsCredential,
  updateDraftForUser,
} from '@nessie/team-admin'
import { safeFetch } from '@nessie/runtime'
import { z } from 'zod'

import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { buildRealtimeScopesForChannel } from './message-destination.js'
import {
  explainGoogleFailure,
  recordGoogleRead,
  resolveGoogleActingUserId,
} from './google-access.js'
import { serializeMailboxResult } from './mailbox-overflow.js'

/**
 * Gmail tools. Reads go live to Gmail rather than the `CommsEvent` store: the
 * store is the async index, and "what did Jana say this morning" must not
 * depend on whether a Pub/Sub push has landed.
 */

const gmailFetch = async (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => {
  const response = await safeFetch(url, init ?? {})
  return {
    ok: response.ok,
    status: response.status,
    json: () => response.json(),
    text: () => response.text(),
  }
}

const encryptionSecret = (): string => {
  const secret = process.env.NESSIE_AUTH_SECRET
  if (!secret) throw new Error('NESSIE_AUTH_SECRET is not configured')
  return secret
}

const SearchSchema = z.object({
  query: z.string().max(500).optional(),
  maxResults: z.number().int().min(1).max(50).optional(),
}).strict()

const ThreadSchema = z.object({ threadId: z.string().min(1) }).strict()
const MessageSchema = z.object({ messageId: z.string().min(1) }).strict()

const DraftSchema = z.object({
  to: z.array(z.string()).min(1).max(50),
  cc: z.array(z.string()).max(50).optional(),
  bcc: z.array(z.string()).max(50).optional(),
  subject: z.string().max(500),
  body: z.string().max(100_000),
  replyToThreadId: z.string().optional(),
}).strict()

const DraftUpdateSchema = DraftSchema.omit({ replyToThreadId: true }).extend({
  draftId: z.string().uuid(),
}).strict()

/** Load a scope-checked, refreshed credential, or refuse in words. */
const credentialFor = async (
  context: BuiltinToolRuntimeContext,
  capabilityId: Parameters<typeof getGoogleCapability>[0],
  userId: string,
) => {
  try {
    return await loadUserGoogleCommsCredential(context.prisma, {
      organizationId: context.channel.organizationId,
      userId,
      requiredScopes: getGoogleCapability(capabilityId).scopes,
      capabilityId,
      encryptionSecret: encryptionSecret(),
    })
  } catch (error) {
    // The coordinator's codes match GmailDraftError's, so one explainer serves
    // both and a missing scope raises the same in-chat grant card either way.
    return explainGoogleFailure(context, capabilityId, userId, {
      code: (error as { code?: string }).code,
      ...(error as object),
    } as never)
  }
}

export const runGmailSearchTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = SearchSchema.parse(input)
  const userId = resolveGoogleActingUserId(context)
  const credential = await credentialFor(context, 'gmail.read', userId)
  // Stamp the basis BEFORE the read returns: the obligation is on the read, and
  // a throw after a successful fetch would otherwise leave the run unrestricted.
  recordGoogleRead(context, credential.ownerUserId)

  const threads = await searchGmailThreads(
    gmailFetch,
    credential.credential.accessToken,
    {
      ...(args.query ? { query: args.query } : {}),
      ...(args.maxResults ? { maxResults: args.maxResults } : {}),
    },
  )
  return {
    inputSummary: `query=${args.query ?? '(recent)'}`,
    outputPreview: serializeMailboxResult(threads, {
      what: 'search result',
      delegateTask: `Search the mailbox for ${args.query ?? 'recent mail'} and `
        + 'report back what matters: who, what they want, and anything needing '
        + 'a reply. Do not quote messages in full.',
    }),
    toolName: 'gmail_search',
  }
}

export const runGmailThreadReadTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = ThreadSchema.parse(input)
  const userId = resolveGoogleActingUserId(context)
  const credential = await credentialFor(context, 'gmail.read', userId)
  recordGoogleRead(context, credential.ownerUserId)
  const messages = await getGmailThread(
    gmailFetch,
    credential.credential.accessToken,
    args.threadId,
  )
  return {
    inputSummary: `threadId=${args.threadId}`,
    outputPreview: serializeMailboxResult(messages, {
      what: 'thread',
      delegateTask: `Read Gmail thread ${args.threadId} with gmail_thread_read `
        + 'and summarise the exchange: who said what, what was decided, and what '
        + 'is still open.',
    }),
    toolName: 'gmail_thread_read',
  }
}

export const runGmailMessageReadTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = MessageSchema.parse(input)
  const userId = resolveGoogleActingUserId(context)
  const credential = await credentialFor(context, 'gmail.read', userId)
  recordGoogleRead(context, credential.ownerUserId)
  const message = await getGmailMessage(
    gmailFetch,
    credential.credential.accessToken,
    args.messageId,
  )
  return {
    inputSummary: `messageId=${args.messageId}`,
    outputPreview: serializeMailboxResult(message, {
      what: 'message',
      delegateTask: `Read Gmail message ${args.messageId} with `
        + 'gmail_message_read and summarise what it says and what it asks for.',
    }),
    toolName: 'gmail_message_read',
  }
}

/**
 * Post the draft card.
 *
 * Metadata carries identifiers only. Recipients and subject are fetched by the
 * viewer through an owner-gated route, because message metadata is readable by
 * everyone who can read the message — and a dictated draft involves no read at
 * all, so the run's basis would be empty and the message unrestricted. The card
 * therefore carries the owner's basis explicitly.
 */
const postDraftCard = async (
  context: BuiltinToolRuntimeContext,
  draftActionId: string,
  ownerUserId: string,
  summary: string,
): Promise<string | null> => {
  recordGoogleRead(context, ownerUserId)
  const thread = await context.prisma.thread.findUnique({
    where: { id: context.run.threadId },
    select: { channel: { select: { id: true, systemChannelType: true } } },
  })
  if (!thread) return null
  const message = await context.prisma.message.create({
    data: {
      content: summary,
      role: 'assistant',
      agentId: context.agentId,
      threadId: parseThreadId(context.run.threadId),
      metadata: {
        card: { kind: 'gmail_draft', draftActionId },
      } as Prisma.InputJsonValue,
    },
    select: { id: true },
  })
  await attachDraftMessage(context.prisma, draftActionId, message.id)
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
        contentPreview: summary.slice(0, 200),
        messageId: message.id,
        role: 'assistant',
        threadId: parseThreadId(context.run.threadId),
      },
      event: 'message.new',
    },
  )
  return message.id
}

export const runGmailDraftCreateTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = DraftSchema.parse(input)
  const userId = resolveGoogleActingUserId(context)
  try {
    const action = await composeDraftForUser(
      context.prisma,
      {
        organizationId: context.channel.organizationId,
        userId,
        message: {
          to: args.to,
          ...(args.cc ? { cc: args.cc } : {}),
          ...(args.bcc ? { bcc: args.bcc } : {}),
          subject: args.subject,
          body: args.body,
        },
        ...(args.replyToThreadId ? { providerThreadId: args.replyToThreadId } : {}),
      },
      { encryptionSecret: encryptionSecret() },
    )
    await postDraftCard(
      context,
      action.id,
      action.ownerUserId,
      `Draft ready: “${args.subject}” to ${args.to.join(', ')}.`,
    )
    return {
      inputSummary: `to=${args.to.length} subject=${args.subject.slice(0, 60)}`,
      outputPreview: JSON.stringify({
        draftId: action.id,
        state: action.state,
        note: 'Draft card posted in the chat with a Send button. Do not send it '
          + 'yourself unless the person asks you to.',
      }),
      toolName: 'gmail_draft_create',
    }
  } catch (error) {
    return explainGoogleFailure(context, 'gmail.compose', userId, error)
  }
}

export const runGmailDraftUpdateTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = DraftUpdateSchema.parse(input)
  const userId = resolveGoogleActingUserId(context)
  try {
    const action = await updateDraftForUser(
      context.prisma,
      {
        organizationId: context.channel.organizationId,
        userId,
        draftActionId: args.draftId,
        message: {
          to: args.to,
          ...(args.cc ? { cc: args.cc } : {}),
          ...(args.bcc ? { bcc: args.bcc } : {}),
          subject: args.subject,
          body: args.body,
        },
      },
      { encryptionSecret: encryptionSecret() },
    )
    return {
      inputSummary: `draftId=${args.draftId}`,
      outputPreview: JSON.stringify({
        draftId: action.id,
        revision: action.revision,
        note: 'The draft card in the chat now shows the new text. Any approval '
          + 'given for the previous version no longer applies.',
      }),
      toolName: 'gmail_draft_update',
    }
  } catch (error) {
    return explainGoogleFailure(context, 'gmail.compose', userId, error)
  }
}
