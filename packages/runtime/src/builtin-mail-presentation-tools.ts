import type { BuiltinToolDefinition } from './builtin-tools-types.js'

export const MAIL_PRESENT_TOOL_ID = 'mail_present'

/**
 * Opens the connected-mail surface without reading, drafting, or sending mail.
 * Provider-specific tools remain the authority for those operations.
 */
export const MAIL_PRESENT_TOOL_DEFINITION: BuiltinToolDefinition = {
  category: 'email-calendar',
  description:
    'Open the connected Mail review surface for an account, one thread, or a '
    + 'compose flow, and leave an Open mail doorway in this conversation. This '
    + 'does not read email, create a draft, or send anything.',
  id: MAIL_PRESENT_TOOL_ID,
  label: 'Open Mail',
  parameters: {
    properties: {
      source: { enum: ['gmail', 'mailbox'], type: 'string' },
      accountId: { description: 'The connected mail account id.', type: 'string' },
      mode: { enum: ['account', 'thread', 'compose'], type: 'string' },
      threadId: { description: 'Provider thread id, when opening a thread or reply.', type: 'string' },
      draftId: { description: 'Gmail draft id, when opening an existing draft.', type: 'string' },
    },
    required: ['source', 'accountId', 'mode'],
    type: 'object',
  },
  requiresExplicitGrant: true,
  // This leaves a durable, restricted doorway in the conversation. It has no
  // provider side effect, but matches card_post rather than a read-only tool.
  safe: false,
  summary: 'Open an entitled connected-mail review surface.',
}
