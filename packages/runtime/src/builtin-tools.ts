export type BuiltinToolDefinition = {
  id: string
  description: string
  label: string
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
  safe: boolean
}

export const BUILTIN_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  {
    id: 'web_search',
    label: 'Web Search',
    description: 'Search the public web. Returns top 3 results with titles and URLs.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query',
        },
      },
      required: ['query'],
    },
    safe: true,
  },
  {
    id: 'web_fetch',
    label: 'Web Fetch',
    description: 'Fetch and read a public URL. Returns the text content.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to fetch',
        },
      },
      required: ['url'],
    },
    safe: true,
  },
  {
    id: 'document_read',
    label: 'Document Read',
    description: 'Read a project-local document by path or topic. Returns markdown content.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Document path or topic to search for',
        },
      },
      required: ['query'],
    },
    safe: true,
  },
]

export const BUILTIN_TOOL_IDS = new Set(
  BUILTIN_TOOL_DEFINITIONS.map((tool) => tool.id),
)
