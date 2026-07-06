import type { BuiltinToolDefinition } from './builtin-tools-types.js'

// Read-only knowledge-base discovery tools shared by every agent (not gated
// behind personalAssistantOnly): search, read a single page's full content,
// and list spaces/page trees. All access is re-checked against the caller's
// own SpaceViewer inside the handlers — these definitions only describe the
// schema, never bypass access.
export const KB_SEARCH_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'kb_search',
  label: 'KB Search',
  description:
    'Search the knowledge base (hybrid semantic + keyword). Returns compact ' +
    'hits; use kb_page_read for full content.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
      spaceId: {
        type: 'string',
        description: 'Optional knowledge-base space id to scope the search to',
      },
      projectId: {
        type: 'string',
        description: 'Optional project id to scope the search to',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of hits to return (1-8, default 5)',
        minimum: 1,
        maximum: 8,
      },
    },
    required: ['query'],
  },
  safe: true,
}

export const KB_PAGE_READ_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'kb_page_read',
  label: 'KB Page Read',
  description: "Read a knowledge page's full text content.",
  parameters: {
    type: 'object',
    properties: {
      pageId: { type: 'string', description: 'Knowledge-base page id' },
    },
    required: ['pageId'],
  },
  safe: true,
}

export const KB_LIST_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'kb_list',
  label: 'KB List',
  description:
    'List knowledge spaces you can access, or the page tree of one space.',
  parameters: {
    type: 'object',
    properties: {
      spaceId: {
        type: 'string',
        description:
          'When set, list the page tree of this space; omit to list spaces instead',
      },
    },
  },
  safe: true,
}

export const KB_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  KB_SEARCH_TOOL_DEFINITION,
  KB_PAGE_READ_TOOL_DEFINITION,
  KB_LIST_TOOL_DEFINITION,
]
