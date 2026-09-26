import type { BuiltinToolDefinition } from './builtin-tools-types.js'

/** Account metadata is a delegated read, never access to a credential. */
export const ACCOUNT_CONNECTIONS_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'account_connections_list',
  category: 'apps',
  label: 'Connected Accounts',
  summary: 'Check saved Browserbase connections and personal model subscriptions.',
  description:
    'Read the requesting person\'s Browserbase connections and linked model plans '
    + 'in this organisation, including health and scope, without reading any key. '
    + 'Check here before saying an account is missing or asking them to connect again. '
    + 'Kimi and other personal model plans are here, not in connector_list. '
    + 'A saved connection is not an agent tool grant, and an unavailable read is not an empty list.',
  parameters: { type: 'object', properties: {} },
  personalAssistantOnly: true,
  requiresLiveRequester: true,
  safe: true,
}
