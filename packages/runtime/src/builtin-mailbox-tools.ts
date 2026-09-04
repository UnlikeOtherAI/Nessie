import type { BuiltinToolDefinition } from './builtin-tools-types.js'
import { MailboxSendToolInputSchema } from './builtin-approval-inputs.js'

export const MAILBOX_SEARCH_TOOL_ID = 'mailbox_search'
export const MAILBOX_READ_TOOL_ID = 'mailbox_read'
export const MAILBOX_COMPOSE_TOOL_ID = 'mailbox_compose'
export const MAILBOX_SEND_TOOL_ID = 'mailbox_send'

/**
 * Tools for a mailbox somebody connected over SMTP/IMAP — agent email Model A
 * (docs/plans/2026-09-02-agent-email.md §2.2). The provider holds the mail;
 * these run live against it and keep no copy.
 *
 * A third mail family beside `gmail_*` and `email_*` looks like duplication and
 * is not: the three name three different resources. `gmail_*` acts on the
 * requesting person's Google account through Google's API, `email_*` acts on
 * the agent's own hosted mailbox and takes no handle at all, and these act on a
 * mailbox a person or a team connected with a password. Collapsing them would
 * give an agent holding two of them an ambiguous send path, which is the one
 * mistake in mail you cannot take back.
 *
 * Every id here is optional-by-default and useless without two separate
 * decisions: the tool-level grant (`requiresExplicitGrant`) and a per-mailbox
 * access row. The tool grant alone reaches nothing.
 */

export const MAILBOX_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  {
    description:
      'Prepare the universal chat-card form for composing from a connected '
      + 'mailbox. It does not send mail; a later Send action still goes through '
      + 'the normal mailbox approval gate.',
    category: 'email-calendar',
    id: MAILBOX_COMPOSE_TOOL_ID,
    label: 'Compose From Mailbox',
    parameters: {
      properties: {
        connectionId: {
          description: 'Which connected mailbox to compose from when more than one is available.',
          type: 'string',
        },
      },
      type: 'object',
    },
    requiresExplicitGrant: true,
    safe: false,
    summary: 'Prepare a universal compose form for a connected mailbox.',
  },
  {
    description:
      'Search a connected mailbox and return matching messages with sender, '
      + 'subject, date and UID. Every field narrows the search and they combine, '
      + 'so prefer a precise search over listing everything. Searches inspect at '
      + 'most the newest 2,000 messages; a notice says when older matches may exist. '
      + 'Omit all fields to get the most recent mail.',
    category: 'email-calendar',
    id: MAILBOX_SEARCH_TOOL_ID,
    label: 'Search Mailbox',
    parameters: {
      properties: {
        connectionId: {
          description:
            'Which connected mailbox. Needed only when more than one is available.',
          type: 'string',
        },
        folder: { description: 'Folder to search. Defaults to INBOX.', type: 'string' },
        from: { description: 'Match the sender address or name.', type: 'string' },
        limit: { description: 'How many messages (1–50, default 15).', type: 'number' },
        since: {
          description: 'Only mail on or after this date, as YYYY-MM-DD.',
          type: 'string',
        },
        subject: { description: 'Match words in the subject.', type: 'string' },
        text: { description: 'Match words anywhere in the message.', type: 'string' },
        unseenOnly: { description: 'Only unread messages.', type: 'boolean' },
      },
      type: 'object',
    },
    requiresExplicitGrant: true,
    safe: true,
    summary: 'Search a connected SMTP/IMAP mailbox.',
  },
  {
    description:
      'Read one message from a connected mailbox in full, by the UID that '
      + 'mailbox_search returned. Reading does not mark it as read for the person '
      + 'whose mailbox it is.',
    category: 'email-calendar',
    id: MAILBOX_READ_TOOL_ID,
    label: 'Read Mailbox Message',
    parameters: {
      properties: {
        connectionId: { type: 'string' },
        folder: { description: 'Defaults to INBOX.', type: 'string' },
        uid: { description: 'The UID from mailbox_search.', type: 'number' },
      },
      required: ['uid'],
      type: 'object',
    },
    requiresExplicitGrant: true,
    safe: true,
    summary: 'Read one message from a connected mailbox.',
  },
  {
    description:
      'Send an email from a connected mailbox. It goes out as that mailbox’s own '
      + 'address — you cannot send as anybody else. Always provide the exact '
      + 'connectionId for that mailbox. A person is asked to approve it before '
      + 'it leaves; you will be told when that happens.',
    category: 'email-calendar',
    id: MAILBOX_SEND_TOOL_ID,
    label: 'Send From Mailbox',
    parameters: {
      properties: {
        bcc: { items: { type: 'string' }, type: 'array' },
        cc: { items: { type: 'string' }, type: 'array' },
        connectionId: {
          description: 'The exact connected mailbox to send from.',
          type: 'string',
        },
        inReplyToUid: {
          description:
            'The UID of the message being replied to, so the recipient’s mail '
            + 'client threads the reply where they expect it.',
          type: 'number',
        },
        subject: { type: 'string' },
        text: { description: 'The message body, as plain text.', type: 'string' },
        to: { items: { type: 'string' }, type: 'array' },
      },
      required: ['connectionId', 'to', 'subject', 'text'],
      type: 'object',
    },
    inputSchema: MailboxSendToolInputSchema,
    requiresExplicitGrant: true,
    // Declared in code, never in `PolicyRule` data: the policy evaluator's
    // default verdict is `allow`, so a data-only gate is simply absent in any
    // organisation whose seed never wrote a send rule.
    requiresApproval: true,
    safe: false,
    summary: 'Send an email from a connected mailbox.',
  },
]
