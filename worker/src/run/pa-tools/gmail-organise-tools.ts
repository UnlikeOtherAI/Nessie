import { getGoogleCapability } from '@nessie/schemas'
import {
  getGmailAttachment,
  listGmailLabels,
  modifyGmailThread,
  respondToEvent,
  searchGoogleContacts,
  trashGmailThread,
} from '@nessie/comms-google'
import { loadUserGoogleCommsCredential } from '@nessie/workspace-admin'
import { safeFetch } from '@nessie/runtime'
import { z } from 'zod'

import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import {
  explainGoogleFailure,
  recordGoogleRead,
  resolveGoogleActingUserId,
} from './google-access.js'
import { serializeMailboxResult } from './mailbox-overflow.js'

/**
 * The tidying and lookup tools: labels, archive, trash, RSVP, contacts, and
 * reading an attachment.
 */

const googleFetch = async (
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
    return explainGoogleFailure(context, capabilityId, userId, {
      code: (error as { code?: string }).code,
      ...(error as object),
    } as never)
  }
}

const OrganiseSchema = z.object({
  threadId: z.string().min(1),
  addLabelIds: z.array(z.string()).max(20).optional(),
  removeLabelIds: z.array(z.string()).max(20).optional(),
  archive: z.boolean().optional(),
  markRead: z.boolean().optional(),
  trash: z.boolean().optional(),
}).strict()

const AttachmentSchema = z.object({
  messageId: z.string().min(1),
  attachmentId: z.string().min(1),
}).strict()

const ContactsSchema = z.object({ query: z.string().min(1).max(200) }).strict()

const RespondSchema = z.object({
  calendarId: z.string().optional(),
  eventId: z.string().min(1),
  response: z.enum(['accepted', 'declined', 'tentative']),
  comment: z.string().max(2000).optional(),
}).strict()

export const runGmailLabelsListTool = async (
  context: BuiltinToolRuntimeContext,
  _input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const userId = resolveGoogleActingUserId(context)
  const credential = await credentialFor(context, 'gmail.read', userId)
  recordGoogleRead(context, credential.ownerUserId)
  const labels = await listGmailLabels(
    googleFetch,
    credential.credential.accessToken,
  )
  return {
    inputSummary: '',
    outputPreview: serializeMailboxResult(labels, {
      what: 'label list',
      delegateTask: 'List the mailbox labels with gmail_labels_list and report '
        + 'the ones that look relevant.',
    }),
    toolName: 'gmail_labels_list',
  }
}

/**
 * Archiving and marking read are label changes in Gmail (`INBOX`, `UNREAD`),
 * so they are folded into one call here rather than three tools that would
 * drift apart. Trash is a separate endpoint and happens last, because a
 * trashed thread's other label changes no longer matter.
 */
export const runGmailOrganiseTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = OrganiseSchema.parse(input)
  const userId = resolveGoogleActingUserId(context)
  const credential = await credentialFor(context, 'gmail.modify', userId)
  recordGoogleRead(context, credential.ownerUserId)

  const addLabelIds = [...(args.addLabelIds ?? [])]
  const removeLabelIds = [...(args.removeLabelIds ?? [])]
  if (args.archive === true) removeLabelIds.push('INBOX')
  if (args.archive === false) addLabelIds.push('INBOX')
  if (args.markRead === true) removeLabelIds.push('UNREAD')
  if (args.markRead === false) addLabelIds.push('UNREAD')

  if (addLabelIds.length > 0 || removeLabelIds.length > 0) {
    await modifyGmailThread(googleFetch, credential.credential.accessToken, {
      threadId: args.threadId,
      addLabelIds,
      removeLabelIds,
    })
  }
  if (args.trash) {
    await trashGmailThread(
      googleFetch,
      credential.credential.accessToken,
      args.threadId,
    )
  }
  return {
    inputSummary: `threadId=${args.threadId}`,
    outputPreview: JSON.stringify({
      threadId: args.threadId,
      applied: addLabelIds,
      removed: removeLabelIds,
      trashed: args.trash === true,
    }),
    toolName: 'gmail_organise',
  }
}

/**
 * Read an attachment.
 *
 * The bytes are decoded and their text handed back when the file is textual;
 * anything else is reported with its type and size rather than pretending to
 * have read it. Storing binary attachments as durable Nessie files goes through
 * the FileService and is not done here — see the plan's open items.
 */
export const runGmailAttachmentReadTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = AttachmentSchema.parse(input)
  const userId = resolveGoogleActingUserId(context)
  const credential = await credentialFor(context, 'gmail.read', userId)
  recordGoogleRead(context, credential.ownerUserId)

  const bytes = await getGmailAttachment(
    googleFetch,
    credential.credential.accessToken,
    args,
  )
  // A quick, content-based check: valid UTF-8 with no NUL bytes reads as text.
  // Guessing from the filename would be wrong for the common untyped cases.
  const isText = !bytes.includes(0)
  const text = isText ? bytes.toString('utf8') : ''
  return {
    inputSummary: `messageId=${args.messageId}`,
    outputPreview: isText
      ? serializeMailboxResult(
          { sizeBytes: bytes.byteLength, text },
          {
            what: 'attachment',
            delegateTask: `Read attachment ${args.attachmentId} on message `
              + `${args.messageId} with gmail_attachment_read and summarise it.`,
          },
        )
      : JSON.stringify({
          sizeBytes: bytes.byteLength,
          note: 'This attachment is not text, so I cannot read it here. Ask the '
            + 'person to open it, or work from what the message says about it.',
        }),
    toolName: 'gmail_attachment_read',
  }
}

export const runContactsSearchTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = ContactsSchema.parse(input)
  const userId = resolveGoogleActingUserId(context)
  const credential = await credentialFor(context, 'contacts.read', userId)
  recordGoogleRead(context, credential.ownerUserId)
  const contacts = await searchGoogleContacts(
    googleFetch,
    credential.credential.accessToken,
    { query: args.query },
  )
  return {
    inputSummary: `query=${args.query}`,
    outputPreview: JSON.stringify(
      contacts.length > 0
        ? contacts
        : {
            contacts: [],
            note: 'No contact matched. Do not guess an address — ask the person '
              + 'for it.',
          },
    ),
    toolName: 'contacts_search',
  }
}

export const runCalendarEventRespondTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = RespondSchema.parse(input)
  const userId = resolveGoogleActingUserId(context)
  const credential = await credentialFor(context, 'calendar.write', userId)
  recordGoogleRead(context, credential.ownerUserId)
  const event = await respondToEvent(
    googleFetch,
    credential.credential.accessToken,
    {
      ...args,
      // The account's own address decides which attendee row is ours; a caller
      // must not be able to answer on somebody else's behalf.
      selfEmail: credential.externalUserId,
    },
  )
  return {
    inputSummary: `eventId=${args.eventId} ${args.response}`,
    outputPreview: JSON.stringify({ id: event.id, title: event.title, response: args.response }),
    toolName: 'calendar_event_respond',
  }
}
