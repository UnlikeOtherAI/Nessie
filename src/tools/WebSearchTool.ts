import { z } from 'zod'
import { buildTool } from './Tool.js'
import type { Tool } from './Tool.js'

const WebSearchSchema = z.object({
  query: z.string(),
})

export type WebSearchInput = z.infer<typeof WebSearchSchema>

type WebSearchResult = { title: string; url: string; snippet: string }
export function createWebSearchTool(): Tool<WebSearchInput, { results: WebSearchResult[] }> {
  return buildTool({
    name: 'WebSearch',
    description: 'Search the web for information',
    inputSchema: WebSearchSchema,

    async call(args, _ctx) {
      // TODO: wire up to Mollotov MCP or search API
      // For now, returns the search URL
      return {
        data: {
          results: [
            {
              title: `Search for: ${args.query}`,
              url: `https://duckduckgo.com/?q=${encodeURIComponent(args.query)}`,
              snippet: 'Web search not yet wired up — open the URL to search.',
            },
          ],
        },
      }
    },

    isConcurrencySafe() { return true },
    isReadOnly() { return true },
    userFacingName: (input) => `Search: ${input?.query ?? ''}`,
    getActivityDescription: (input) => `Searching for: ${input?.query ?? ''}`,
    maxResultSizeChars: 10_000,
  })
}

export const WebSearchTool = createWebSearchTool()
