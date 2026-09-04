import { getGoogleCapability } from '@nessie/schemas'
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
  type GmailDraftActionRecord,
} from '@nessie/team-admin'
import { safeFetch } from '@nessie/runtime'
import { z } from 'zod'

import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { createAgentMessage } from '../execute/agent-message.js'
import { applyRunReplyBookkeeping } from '../execute/lifecycle.js'
import { publishMessageCreated } from '../execute/realtime.js'
import {
  explainGoogleFailure,
  recordGoogleRead,
  resolveGoogleActingUserId,
} from './google-access.js'
import { serializeMailboxResult } from './mailbox-overflow.js'
import {
  appendMailPresentationReferences,
  mailPresentationReference,
} from './mail-presentation-reference.js'

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
  const outputPreview = serializeMailboxResult(threads, {
    what: 'search result',
    delegateTask: `Search the mailbox for ${args.query ?? 'recent mail'} and `
      + 'report back what matters: who, what they want, and anything needing '
      + 'a reply. Do not quote messages in full.',
  })
  return {
    inputSummary: `query=${args.query ?? '(recent)'}`,
    outputPreview: appendMailPresentationReferences(outputPreview, threads.map((thread) =>
      mailPresentationReference({
        accountId: credential.id,
        mode: 'thread',
        source: 'gmail',
        threadId: thread.threadId,
      }))),
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
  const outputPreview = serializeMailboxResult(messages, {
    what: 'thread',
    delegateTask: `Read Gmail thread ${args.threadId} with gmail_thread_read `
      + 'and summarise the exchange: who said what, what was decided, and what '
      + 'is still open.',
  })
  return {
    inputSummary: `threadId=${args.threadId}`,
    outputPreview: appendMailPresentationReferences(outputPreview, [
      mailPresentationReference({
        accountId: credential.id,
        mode: 'thread',
        source: 'gmail',
        threadId: args.threadId,
      }),
    ]),
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
  const outputPreview = serializeMailboxResult(message, {
    what: 'message',
    delegateTask: `Read Gmail message ${args.messageId} with `
      + 'gmail_message_read and summarise what it says and what it asks for.',
  })
  return {
    inputSummary: `messageId=${args.messageId}`,
    outputPreview: appendMailPresentationReferences(outputPreview, [
      mailPresentationReference({
        accountId: credential.id,
        mode: 'thread',
        source: 'gmail',
        threadId: message.threadId,
      }),
    ]),
    toolName: 'gmail_message_read',
  }
}

/**
 * Post the content-free draft doorway.
 *
 * A Gmail draft includes the recipient and message body, so this must follow
 * the same disclosure-stamped write and restricted realtime path as a reply.
 * The live Mail API, not durable chat content or metadata, renders the draft.
 */
export const postGmailDraftDoorway = async (
  context: BuiltinToolRuntimeContext,
  action: GmailDraftActionRecord,
): Promise<string | null> => {
  recordGoogleRead(context, action.ownerUserId)
  const runContext = context.runContext
  if (!runContext) return null
  const message = await createAgentMessage(context.prisma, runContext, {
    agentId: context.agentId,
    content: 'Draft ready. Open Mail to review and send it.',
    metadata: {
      mailSurfaceDoorway: {
        accountId: action.connectionId,
        draftId: action.id,
        mode: 'compose',
        source: 'gmail',
      },
    },
    role: 'assistant',
    threadId: context.run.threadId,
    ...(runContext.replyRootMessageId ? { rootMessageId: runContext.replyRootMessageId } : {}),
  })
  await attachDraftMessage(context.prisma, action.id, message.id)
  const reply = runContext.replyRootMessageId
    ? await applyRunReplyBookkeeping(context.prisma, runContext, message.createdAt)
    : undefined
  await publishMessageCreated(context.realtimeTransport, runContext, {
    content: message.content,
    messageId: message.id,
    role: 'assistant',
    ...(message.basis.length > 0 ? { restricted: true } : {}),
    ...(reply ? { reply } : {}),
  })
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
        idempotencyKey: randomUUID(),
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
    await postGmailDraftDoorway(context, action)
    const presentation = mailPresentationReference({
      accountId: action.connectionId,
      draftId: action.id,
      mode: 'compose',
      source: 'gmail',
    })
    return {
      inputSummary: `to=${args.to.length} subject=${args.subject.slice(0, 60)}`,
      outputPreview: JSON.stringify({
        draftId: action.id,
        mailPresentation: presentation,
        state: action.state,
        note: 'A restricted Open Mail doorway is in the chat. Do not send it '
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
        mailPresentation: mailPresentationReference({
          accountId: action.connectionId,
          draftId: action.id,
          mode: 'compose',
          source: 'gmail',
        }),
        revision: action.revision,
        note: 'The existing Open Mail doorway now shows the new text. Any approval '
          + 'given for the previous version no longer applies.',
      }),
      toolName: 'gmail_draft_update',
    }
  } catch (error) {
    return explainGoogleFailure(context, 'gmail.compose', userId, error)
  }
}
import { randomUUID } from 'node:crypto'
