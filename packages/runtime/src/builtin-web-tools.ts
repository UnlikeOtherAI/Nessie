import type { BuiltinToolDefinition } from './builtin-tools-types.js'

export const WEB_SEARCH_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'web_search',
  category: 'web',
  summary: 'Search the public web for current results and answer snippets.',
  label: 'Web Search',
  description:
    'Search the public web through Ledger-metered results for up-to-date ' +
    'outside information. Returns top results with titles, URLs, and snippets, ' +
    'plus a direct answer when one is available. Set `present` to show the ' +
    'person the results themselves as a search card in this conversation; ' +
    'leave it off when you only need the facts to answer in your own words.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
      page: {
        type: 'integer',
        description:
          'Results page to fetch (1-indexed, default 1). Use 2, 3, 4… ' +
          'to reach deeper results beyond the first page.',
        minimum: 1,
      },
      count: {
        type: 'integer',
        description:
          'How many results to return (1-10, default 5). Ask for 10 when you ' +
          'are presenting the results, so the card shows a full page.',
        minimum: 1,
        maximum: 10,
      },
      present: {
        type: 'boolean',
        description:
          'Post the results into this conversation as a search card the person ' +
          'can read and page through themselves. Default false — you always get ' +
          'the results either way, so set this only when seeing the sources is ' +
          'the point (they asked for links, want to browse, or should judge the ' +
          'sources for themselves).',
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
