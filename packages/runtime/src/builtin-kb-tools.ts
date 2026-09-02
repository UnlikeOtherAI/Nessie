import type { BuiltinToolDefinition } from './builtin-tools-types.js'

// Read-only knowledge-base discovery tools shared by every agent (not gated
// behind personalAssistantOnly): search, read a single page's full content,
// and list spaces/page trees. All access is re-checked against the caller's
// own SpaceViewer inside the handlers — these definitions only describe the
// schema, never bypass access.
export const KB_SEARCH_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'kb_search',
  category: 'knowledge',
  summary: 'Search accessible knowledge pages by semantic and keyword matching.',
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
      taskId: {
        type: 'string',
        description: 'Optional ticket (task) id — restricts results to documents bound to this ticket',
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
  category: 'knowledge',
  summary: 'Read the full text of one knowledge-base page.',
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
  category: 'knowledge',
  summary: 'List knowledge spaces, page trees, or task documents you can access.',
  label: 'KB List',
  description:
    'List knowledge spaces you can access, the page tree of one space, or the ' +
    'documents filed under a ticket.',
  parameters: {
    type: 'object',
    properties: {
      spaceId: {
        type: 'string',
        description:
          'When set, list the page tree of this space; omit to list spaces instead',
      },
      taskId: {
        type: 'string',
        description:
          'When set, list the documents bound to this ticket (task) instead of a space tree',
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
  category: 'knowledge',
  summary: 'Create a rich-text page draft or a new draft version for review.',
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
      taskId: {
        type: 'string',
        description:
          'Optional ticket (task) id to bind a new page to (new pages only — ignored when ' +
          'adding a version to an existing page via pageId)',
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

/**
 * The tool id is referenced by the worker's document-stream recorder, which
 * decides from the streaming tool name alone whether to open a live document
 * session. Keep them in one place so the two can never drift.
 */
export const KB_DOCUMENT_COMPOSE_TOOL_ID = 'kb_document_compose'

// Writes a markdown file rather than a rich-text page: the artifact is the .md
// itself, so nothing here converts to HTML. Arguments are ordered
// location-then-body deliberately — models emit them in schema order, which
// lets the live popup show the title and destination while the body is still
// arriving.
export const KB_DOCUMENT_COMPOSE_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: KB_DOCUMENT_COMPOSE_TOOL_ID,
  category: 'knowledge',
  summary: 'Live-write a complete markdown document as a new knowledge-base file.',
  label: 'KB Document Compose',
  description:
    'Write a complete markdown document and save it as a .md file in the knowledge base. '
    + 'Agree the destination with the person first (use kb_list to resolve names to ids). '
    + 'The person watches the document appear live as you write it, so put the finished '
    + 'document in `markdown` with no preamble, commentary, or wrapper fences.',
  parameters: {
    type: 'object',
    properties: {
      spaceId: {
        type: 'string',
        description: 'Knowledge-base space id to save the document in',
      },
      parentPageId: {
        type: 'string',
        description: 'Optional folder/page id to nest the document under',
      },
      title: {
        type: 'string',
        description: 'Document title. The saved file is named "<title>.md".',
      },
      summary: { type: 'string', description: 'Optional one-line summary' },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional labels (max 16)',
        maxItems: 16,
      },
      taskId: { type: 'string', description: 'Optional ticket id to bind the document to' },
      changeComment: { type: 'string', description: 'Optional note describing this document' },
      markdown: {
        type: 'string',
        description: 'The complete document body, in GitHub-flavored markdown',
      },
    },
    required: ['spaceId', 'title', 'markdown'],
  },
  safe: false,
}

export const KB_DOCUMENT_EDIT_TOOL_ID = 'kb_document_edit'

// Targeted edits rather than a rewrite: the person watches each change land in
// place in the existing document, and only the changed passages are generated.
export const KB_DOCUMENT_EDIT_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: KB_DOCUMENT_EDIT_TOOL_ID,
  category: 'knowledge',
  summary: 'Apply targeted exact-match edits to an existing markdown document.',
  label: 'KB Document Edit',
  description:
    'Change parts of an existing markdown document in place. Prefer this over rewriting: '
    + 'give only the passages that change. Each edit finds an exact snippet of the current '
    + 'document and replaces it, so `find` must match the file exactly once — include '
    + 'enough surrounding text to be unambiguous. An empty `replace` deletes the snippet. '
    + 'The person watches each change appear where it belongs, so edit in document order.',
  parameters: {
    type: 'object',
    properties: {
      pageId: { type: 'string', description: 'Id of the .md document page to edit' },
      changeComment: {
        type: 'string',
        description: 'Optional short note describing this revision',
      },
      edits: {
        type: 'array',
        description: 'Edits to apply, in document order',
        items: {
          type: 'object',
          properties: {
            find: {
              type: 'string',
              description:
                'Exact snippet of the current document to replace. Must occur exactly once.',
            },
            replace: {
              type: 'string',
              description: 'Replacement text. Empty string deletes the snippet.',
            },
          },
          required: ['find', 'replace'],
        },
        maxItems: 40,
      },
    },
    required: ['pageId', 'edits'],
  },
  safe: false,
}

export const KB_FILE_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'kb_file',
  category: 'knowledge',
  summary: 'Move, rename, or relabel a knowledge-base draft.',
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
  category: 'knowledge',
  summary: 'Request human review and publication of a knowledge-page draft.',
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
  KB_DOCUMENT_COMPOSE_TOOL_DEFINITION,
  KB_DOCUMENT_EDIT_TOOL_DEFINITION,
  KB_FILE_TOOL_DEFINITION,
  KB_PUBLISH_REQUEST_TOOL_DEFINITION,
]
