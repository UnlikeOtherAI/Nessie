import type { BuiltinToolDefinition } from './builtin-tools-types.js'

export const CONVERSATION_REFERENCE_TOOL_ID = 'conversation_reference'

/**
 * Show a conversation with an agent as a live card in this chat.
 *
 * Registered exactly like `card_post` and for the same reason: `safe: false`,
 * no `personalAssistantOnly`, no explicit grant. Pointing at a conversation is
 * a better-shaped message, not a wider permission — what a viewer then sees is
 * decided per viewer by the card's own read
 * (`GET /api/threads/:threadId/conversation`), and the handler bounds which
 * conversations may be pointed at: the acting person's own visibility, or, for
 * a run with nobody asking, its own channel.
 *
 * Spec: docs/plans/2026-09-08-agent-conversations.md § "The doorway".
 */
export const CONVERSATION_REFERENCE_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: CONVERSATION_REFERENCE_TOOL_ID,
  category: 'conversation',
  summary: 'Show a conversation with an agent as a live card in this chat.',
  label: 'Show conversation',
  description:
    'Put a live card for another conversation into this chat, so the person can watch '
    + 'it or step into it without being sent to go and look. The card reads itself: it '
    + 'shows the conversation\'s title, whether it is running, queued, waiting or done, '
    + 'what it is doing right now, and opens it when pressed — all of it current every '
    + 'time anyone looks. So do NOT narrate the status in your own words, and never '
    + 'state one you were not told: say why you are showing it and let the card say how '
    + 'it is going. Take the thread id from agent_conversations_list or from a '
    + 'conversation you just started; never invent one.',
  parameters: {
    type: 'object',
    properties: {
      conversation: {
        type: 'string',
        description: 'The conversation to show, by thread id.',
      },
      note: {
        type: 'string',
        description:
          'Optional one line to post with the card, e.g. why you are showing it. '
          + 'Omit for a plain default. Never a status — the card carries that.',
      },
    },
    required: ['conversation'],
  },
  safe: false,
}

export const NESSIE_LINK_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'nessie_link', category: 'conversation', label: 'Link to Nessie',
  summary: 'Create a named link to a looked-up Nessie resource.', safe: true,
  description: 'Create a Markdown link using a name and identifiers already returned by a lookup tool. '
    + 'Use this when that result has no link. This formats a route; it does not discover resources, '
    + 'verify existence or grant access. A document needs its spaceId; a ticket or board needs projectId; '
    + 'a conversation needs channelId; a message needs channelId and threadId; a terminal needs executorId. '
    + 'For a message reply, supply its rootMessageId too. IDs belong in tool arguments, not visible prose.',
  parameters: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: [
        'agent', 'executor', 'terminal', 'trigger', 'task_set', 'channel', 'conversation', 'message',
        'project', 'board', 'ticket', 'dashboard', 'space', 'document', 'app', 'connection',
      ] },
      id: { type: 'string', minLength: 1 }, name: { type: 'string', minLength: 1 },
      projectId: { type: 'string' }, channelId: { type: 'string' }, threadId: { type: 'string' },
      spaceId: { type: 'string' }, executorId: { type: 'string' }, rootMessageId: { type: 'string' },
    },
    required: ['kind', 'id', 'name'],
  },
}
