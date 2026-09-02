import type { BuiltinToolDefinition } from './builtin-tools-types.js'

export const EMAIL_SEND_TOOL_ID = 'email_send'
export const EMAIL_LIST_TOOL_ID = 'email_list'
export const EMAIL_READ_TOOL_ID = 'email_read'

/**
 * Tools for an agent's own hosted mailbox (docs/plans/2026-09-02-agent-email.md
 * Model B). Deliberately **not** `personalAssistantOnly`: any agent that has
 * been given an address can use these. They reach exactly one resource — the
 * running agent's own mailbox — so they take no connection handle and cannot
 * be pointed at anybody else's correspondence.
 */

export const EMAIL_SEND_TOOL_DEFINITION: BuiltinToolDefinition = {
  description:
    'Send an email from your own mailbox. Called while working on an email '
    + 'conversation it replies in that thread by default — recipients, subject '
    + 'and threading headers are filled in for you, so pass only `text`. Give '
    + '`to` explicitly to start a new conversation instead. Depending on this '
    + 'mailbox\'s policy a person may have to approve the message before it '
    + 'leaves; you will be told when that happens.',
  id: EMAIL_SEND_TOOL_ID,
  label: 'Send Email',
  parameters: {
    properties: {
      bcc: {
        description: 'Blind copy recipients. Never disclosed to other recipients.',
        items: { type: 'string' },
        type: 'array',
      },
      cc: { items: { type: 'string' }, type: 'array' },
      subject: {
        description:
          'Subject. Omit when replying — the conversation\'s subject is reused.',
        type: 'string',
      },
      text: { description: 'The message body, as plain text.', type: 'string' },
      to: {
        description:
          'Recipients. Omit when replying to the conversation you are working on.',
        items: { type: 'string' },
        type: 'array',
      },
    },
    required: ['text'],
    type: 'object',
  },
  // Explicit grant: an address is an outward-facing identity, and sending is
  // the one thing here a person cannot take back.
  requiresExplicitGrant: true,
  // …and the approval requirement is declared in code, not in policy data: the
  // policy evaluator's default verdict is `allow`, so a data-only gate would be
  // absent in every organisation whose seed never wrote a send rule.
  requiresApproval: true,
  safe: false,
  summary: 'Send an email from this agent’s mailbox.',
}

export const EMAIL_LIST_TOOL_DEFINITION: BuiltinToolDefinition = {
  description:
    'List recent email conversations in your own mailbox, newest first. Use it '
    + 'to answer questions about your correspondence from any conversation you '
    + 'are in, not just while working on a message.',
  id: EMAIL_LIST_TOOL_ID,
  label: 'List Email',
  parameters: {
    properties: {
      limit: { description: 'How many conversations (default 20, max 50).', type: 'number' },
    },
    type: 'object',
  },
  // Reading your own mailbox needs no grant: the mailbox exists because
  // somebody gave this agent an address.
  safe: true,
  summary: 'List conversations in this agent’s mailbox.',
}

export const EMAIL_READ_TOOL_DEFINITION: BuiltinToolDefinition = {
  description:
    'Read the full messages of one email conversation in your own mailbox, '
    + 'oldest first. Pass the conversationId from email_list, or omit it to '
    + 'read the conversation you are currently working on.',
  id: EMAIL_READ_TOOL_ID,
  label: 'Read Email',
  parameters: {
    properties: {
      conversationId: { type: 'string' },
    },
    type: 'object',
  },
  safe: true,
  summary: 'Read one email conversation in this agent’s mailbox.',
}

export const EMAIL_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  EMAIL_SEND_TOOL_DEFINITION,
  EMAIL_LIST_TOOL_DEFINITION,
  EMAIL_READ_TOOL_DEFINITION,
]
