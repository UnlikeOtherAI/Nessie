import type { BuiltinToolDefinition } from './builtin-tools-types.js'

/**
 * MCP connector management tools for the personal assistant.
 *
 * All of these are `personalAssistantOnly`: they act with the requesting
 * user's own connector rights (install/manage at their user scope; shared
 * scopes only when the user's org role allows it), so exposing them to shared
 * agents would let one channel member drive another member's connector setup.
 * The handlers live in `worker/src/run/pa-tools/connectors.ts` and re-check
 * every permission against the database — these definitions only describe
 * schemas.
 */

export const CONNECTOR_LIST_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'connector_list',
  summary: 'List reachable MCP connector installs and their setup state.',
  label: 'Connector List',
  description:
    'List the MCP connectors you can reach: your own installs plus the ones '
    + 'shared with your organisation, teams and channels. Shows setup state '
    + 'and discovered tool counts.',
  parameters: {
    type: 'object',
    properties: {},
  },
  safe: true,
  personalAssistantOnly: true,
}

export const CONNECTOR_LIBRARY_SEARCH_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'connector_library_search',
  summary: 'Find available MCP connectors by service name.',
  label: 'Connector Library Search',
  description:
    'Search for available MCP connectors by service name (e.g. "notion", '
    + '"stripe", "github"). Searches the organisation catalog, the curated '
    + 'library of well-known servers, and the public MCP registry. Returns '
    + 'install candidates with endpoint + auth requirements.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Service or product name to search for' },
    },
    required: ['query'],
  },
  safe: true,
  personalAssistantOnly: true,
}

export const CONNECTOR_DISCOVER_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'connector_discover',
  summary: 'Probe a URL or domain for an installable MCP endpoint.',
  label: 'Connector Discover',
  description:
    'Given a URL (or domain) the user pasted, probe it for an MCP endpoint: '
    + 'tries the address plus well-known paths (/mcp, /sse), detects whether '
    + 'credentials are required, and returns an installable proposal. Use '
    + 'this when the user only has a link.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL or domain to probe' },
    },
    required: ['url'],
  },
  safe: true,
  personalAssistantOnly: true,
}

export const CONNECTOR_INSTALL_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'connector_install',
  summary: 'Install an MCP connector from the catalog or a remote endpoint.',
  label: 'Connector Install',
  description:
    'Install an MCP connector. Either pass catalogEntryId (from '
    + 'connector_list / an org catalog hit) or a name + url + transport + '
    + 'authMethod (from connector_library_search or connector_discover) to '
    + 'register and install in one step. Installs at your personal scope by '
    + 'default; owners/admins can pass scope "organization", "team" or '
    + '"channel" to share it (team/channel default to the current context '
    + 'when no scopeId is given). After a no-auth install the connector is '
    + 'tested and its tools discovered automatically; if it needs a '
    + 'credential, ask the user for it and call connector_set_secret.',
  parameters: {
    type: 'object',
    properties: {
      catalogEntryId: {
        type: 'string',
        description: 'Existing catalog entry id to install',
      },
      name: {
        type: 'string',
        description: 'Machine name (lowercase slug) when registering a new connector',
      },
      label: { type: 'string', description: 'Human label for a new connector' },
      description: { type: 'string', description: 'Short description for a new connector' },
      url: { type: 'string', description: 'Remote MCP endpoint URL for a new connector' },
      transport: {
        type: 'string',
        enum: ['http', 'sse'],
        description: 'Remote transport (streamable HTTP or legacy SSE)',
      },
      authMethod: {
        type: 'string',
        enum: ['none', 'bearer', 'api_key', 'oauth2'],
        description:
          'How the server authenticates (oauth2 = sign-in based; the install '
          + 'response includes the authorization link)',
      },
      scope: {
        type: 'string',
        enum: ['user', 'organization', 'team', 'channel'],
        description: 'Install scope; defaults to "user" (just for this user)',
      },
      scopeId: {
        type: 'string',
        description: 'Target id for team/channel scope (defaults to the current context)',
      },
    },
  },
  safe: false,
  personalAssistantOnly: true,
}

export const CONNECTOR_AUTHORIZE_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'connector_authorize',
  summary: 'Start OAuth authorization for an installed MCP connector.',
  label: 'Connector Authorize',
  description:
    'Start an OAuth sign-in for a connector that supports it (authMethod '
    + 'oauth2). Returns a link the user must open in their browser to approve '
    + 'access with their existing account — send them the link, then call '
    + 'connector_test once they confirm they have finished signing in.',
  parameters: {
    type: 'object',
    properties: {
      instanceId: { type: 'string', description: 'Connector instance id' },
    },
    required: ['instanceId'],
  },
  safe: false,
  personalAssistantOnly: true,
}

export const CONNECTOR_TEST_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'connector_test',
  summary: 'Test a connector and discover its available tools.',
  label: 'Connector Test',
  description:
    'Test a connector instance: connects to the server, lists its tools and '
    + 'registers them. Run after installing or after setting a credential.',
  parameters: {
    type: 'object',
    properties: {
      instanceId: { type: 'string', description: 'Connector instance id' },
    },
    required: ['instanceId'],
  },
  safe: false,
  personalAssistantOnly: true,
}

export const CONNECTOR_SET_SECRET_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'connector_set_secret',
  summary: 'Store a write-only credential for an MCP connector.',
  label: 'Connector Set Secret',
  description:
    'Store the credential (API key / token) for a connector instance. The '
    + 'secret is encrypted at rest and never shown again. For your own '
    + 'connectors it becomes the connection credential; for shared connectors '
    + 'it is stored as your personal credential unless you manage that scope '
    + 'and pass shared=true. The connector is re-tested automatically.',
  parameters: {
    type: 'object',
    properties: {
      instanceId: { type: 'string', description: 'Connector instance id' },
      secret: { type: 'string', description: 'The credential value the user provided' },
      shared: {
        type: 'boolean',
        description:
          'Store as the shared default credential for everyone using this '
          + 'connector (requires manage rights on its scope)',
      },
    },
    required: ['instanceId', 'secret'],
  },
  safe: false,
  personalAssistantOnly: true,
}

export const CONNECTOR_UNINSTALL_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'connector_uninstall',
  summary: 'Remove a manageable MCP connector and its registered tools.',
  label: 'Connector Uninstall',
  description:
    'Remove a connector instance you are allowed to manage, together with its '
    + 'registered tools.',
  parameters: {
    type: 'object',
    properties: {
      instanceId: { type: 'string', description: 'Connector instance id' },
    },
    required: ['instanceId'],
  },
  safe: false,
  personalAssistantOnly: true,
}

export const CONNECTOR_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  CONNECTOR_LIST_TOOL_DEFINITION,
  CONNECTOR_LIBRARY_SEARCH_TOOL_DEFINITION,
  CONNECTOR_DISCOVER_TOOL_DEFINITION,
  CONNECTOR_INSTALL_TOOL_DEFINITION,
  CONNECTOR_AUTHORIZE_TOOL_DEFINITION,
  CONNECTOR_TEST_TOOL_DEFINITION,
  CONNECTOR_SET_SECRET_TOOL_DEFINITION,
  CONNECTOR_UNINSTALL_TOOL_DEFINITION,
]
