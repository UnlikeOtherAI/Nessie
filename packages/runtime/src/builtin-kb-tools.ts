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

// Write tools: agents may draft, file, and request publication of knowledge
// pages, but never publish directly (see api/src/routes/knowledge-base.ts —
// the publish endpoint rejects agent actors). All three are unsafe (require
// approval-gated tool-call confirmation) since they mutate the knowledge base,
// even though the mutation itself only ever produces a draft.
export const KB_DRAFT_WRITE_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'kb_draft_write',
  label: 'KB Draft Write',
  description:
    'Create a knowledge page or add a new draft version to an existing page. ' +
    'Drafts only — a human reviews and publishes.',
  parameters: {
    type: 'object',
    properties: {
      spaceId: {
        type: 'string',
        description: 'Knowledge-base space id to create the page in (required when creating a new page)',
      },
      pageId: {
        type: 'string',
        description:
          'Existing page id — when set, adds a new draft version to this page instead of creating a new one',
      },
      title: { type: 'string', description: 'Page title (required when creating a new page)' },
      body: { type: 'string', description: 'Draft body as an HTML string' },
      summary: { type: 'string', description: 'Optional short summary of the page' },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional labels for the page (max 16)',
        maxItems: 16,
      },
      parentPageId: {
        type: 'string',
        description: 'Optional parent page id to nest this page under (new pages only)',
      },
      changeComment: {
        type: 'string',
        description: 'Optional short note describing this draft/version',
      },
    },
    required: ['body'],
  },
  safe: false,
}

export const KB_FILE_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'kb_file',
  label: 'KB File',
  description: 'File a draft: move it in the tree, rename it, or set labels.',
  parameters: {
    type: 'object',
    properties: {
      pageId: { type: 'string', description: 'Knowledge-base page id' },
      parentPageId: {
        type: 'string',
        description: 'New parent page id to move this page under; pass null to move it to the space root',
      },
      position: { type: 'integer', description: 'New sort position among its new siblings' },
      title: { type: 'string', description: 'New title' },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'Replacement label set (max 16)',
        maxItems: 16,
      },
    },
    required: ['pageId'],
  },
  safe: false,
}

export const KB_PUBLISH_REQUEST_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'kb_publish_request',
  label: 'KB Publish Request',
  description: 'Request human review + publication of a draft page you wrote.',
  parameters: {
    type: 'object',
    properties: {
      pageId: { type: 'string', description: 'Knowledge-base page id' },
      reason: { type: 'string', description: 'Optional short justification shown to the reviewer' },
    },
    required: ['pageId'],
  },
  safe: false,
}

export const KB_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  KB_SEARCH_TOOL_DEFINITION,
  KB_PAGE_READ_TOOL_DEFINITION,
  KB_LIST_TOOL_DEFINITION,
  KB_DRAFT_WRITE_TOOL_DEFINITION,
  KB_FILE_TOOL_DEFINITION,
  KB_PUBLISH_REQUEST_TOOL_DEFINITION,
]
