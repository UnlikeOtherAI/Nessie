import type { BuiltinToolDefinition } from './builtin-tools-types.js'

/** A bounded, durable agent-to-agent request. It is not a chat-message trigger. */
export const AGENT_PEER_DELEGATE_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'agent_peer_delegate',
  category: 'agents',
  label: 'Ask Bound Peer',
  summary: 'Ask another agent bound to this project channel for a focused review.',
  description: 'Send a durable, bounded request to an ordinary agent already bound to this project channel. The original project administrator remains the requester; use it only to reach agreement or ask one focused follow-up.',
  parameters: { type: 'object', properties: { agentId: { type: 'string' }, brief: { type: 'string' } }, required: ['agentId', 'brief'] },
  safe: false,
  requiresExplicitGrant: true,
}
