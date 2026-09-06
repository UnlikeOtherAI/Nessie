import type { BuiltinToolDefinition } from './builtin-tools-types.js'

export const WEB_SEARCH_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'web_search',
  category: 'web',
  summary: 'Search the public web for current results and answer snippets.',
  label: 'Web Search',
  description:
    'Search the public web through Ledger-metered Serper results for up-to-date ' +
    'outside information. Returns top results with titles, URLs, and snippets, ' +
    'plus a direct answer when one is available.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
      page: {
        type: 'integer',
        description:
          'Google results page to fetch (1-indexed, default 1). Use 2, 3, 4… ' +
          'to reach deeper results beyond the first page.',
        minimum: 1,
      },
    },
    required: ['query'],
  },
  safe: true,
}

export const WEB_FETCH_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'web_fetch',
  category: 'web',
  summary: 'Extract readable text from a public web page URL.',
  label: 'Web Fetch',
  description: 'Fetch and read a public URL. Returns the text content.',
  parameters: {
    type: 'object',
    properties: { url: { type: 'string', description: 'The URL to fetch' } },
    required: ['url'],
  },
  safe: true,
}
