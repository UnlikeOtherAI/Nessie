import {
  AppConnectRequestToolInputSchema,
  AppConnectRequestToolOutputSchema,
  AppSearchToolInputSchema,
  AppSearchToolOutputSchema,
} from '@nessie/schemas'

import type { BuiltinToolDefinition } from './builtin-tools-types.js'

export const APP_SEARCH_TOOL_ID = 'app_search'
export const APP_CONNECT_REQUEST_TOOL_ID = 'app_connect_request'

export const APP_SEARCH_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: APP_SEARCH_TOOL_ID,
  summary: 'Search the Apps catalogue for services the user may connect.',
  label: 'Search Apps',
  description:
    'Search the Apps catalogue for services that could provide a needed capability. '
    + 'Use the returned catalogEntryId values exactly when proposing up to three choices '
    + 'with app_connect_request. Never invent an app, connection link, account, or credential.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'What capability or service to search the Apps catalogue for.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 10,
        description: 'Maximum number of matching Apps to return (default 5).',
      },
    },
    required: ['query'],
  },
  safe: true,
  inputSchema: AppSearchToolInputSchema,
  outputSchema: AppSearchToolOutputSchema,
}

/**
 * A PA-only presentation tool. It is intentionally an ordinary default-allow
 * builtin: a person can ask their own PA to begin setup without first editing
 * a policy. A per-agent `false` policy remains an ordinary hard deny.
 */
export const APP_CONNECT_REQUEST_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: APP_CONNECT_REQUEST_TOOL_ID,
  summary: 'Offer an in-chat card to connect one of up to three Apps.',
  label: 'Request App Connection',
  personalAssistantOnly: true,
  description:
    'Present up to three real Apps from app_search in this Personal Assistant chat. '
    + 'This only offers a server-backed choice card; it does not install an App, open '
    + 'sign-in, grant capabilities, accept credentials, or claim that anything is connected.',
  parameters: {
    type: 'object',
    properties: {
      candidateCatalogEntryIds: {
        type: 'array',
        minItems: 1,
        maxItems: 3,
        items: {
          type: 'string',
          format: 'uuid',
          description: 'A catalogEntryId returned by app_search.',
        },
        description: 'One to three real Apps to offer.',
      },
      reason: {
        type: 'string',
        description: 'A short explanation of the capability the Apps would enable.',
      },
    },
    required: ['candidateCatalogEntryIds', 'reason'],
  },
  safe: false,
  inputSchema: AppConnectRequestToolInputSchema,
  outputSchema: AppConnectRequestToolOutputSchema,
}

export const APP_SETUP_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  APP_SEARCH_TOOL_DEFINITION,
  APP_CONNECT_REQUEST_TOOL_DEFINITION,
]
