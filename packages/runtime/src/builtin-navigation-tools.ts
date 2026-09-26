import type { BuiltinToolDefinition } from './builtin-tools-types.js'

export const NESSIE_LINK_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'nessie_link', category: 'conversation', label: 'Link to Nessie',
  summary: 'Create a named Nessie link from kind, id and name, plus parent context for nested resources.', safe: true,
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
