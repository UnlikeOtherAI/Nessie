import type { BuiltinToolDefinition } from './builtin-tools-types.js'

// Agent tools for knowledge-base discussion. Comments are page-level; notes are
// anchored to a quoted span of the page body. Replies and resolve are shared by
// both kinds. Backed by the same access-checked service the REST API uses.
export const KB_COMMENTS_LIST_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'kb_comments_list',
  label: 'KB Comments List',
  description:
    'List the comments and notes on a knowledge-base page you can read. Returns ' +
    'each top-level item with its author, state (open/resolved), the quoted text ' +
    'for notes, and its replies.',
  parameters: {
    type: 'object',
    properties: {
      pageId: { type: 'string', description: 'Knowledge-base page id' },
      kind: {
        type: 'string',
        enum: ['comment', 'note'],
        description: 'Optional filter: only comments or only notes',
      },
    },
    required: ['pageId'],
  },
  safe: true,
}

export const KB_COMMENT_ADD_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'kb_comment_add',
  label: 'KB Comment Add',
  description:
    'Post a page-level comment on a knowledge-base page (shown in the discussion ' +
    'below the document). Use kb_note_add to comment on a specific passage instead.',
  parameters: {
    type: 'object',
    properties: {
      pageId: { type: 'string', description: 'Knowledge-base page id' },
      body: { type: 'string', description: 'Comment text' },
    },
    required: ['pageId', 'body'],
  },
  safe: false,
}

export const KB_COMMENT_REPLY_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'kb_comment_reply',
  label: 'KB Comment Reply',
  description:
    'Reply to an existing comment or note. Pass the id of the top-level item ' +
    '(from kb_comments_list) as annotationId.',
  parameters: {
    type: 'object',
    properties: {
      annotationId: { type: 'string', description: 'Top-level comment or note id' },
      body: { type: 'string', description: 'Reply text' },
    },
    required: ['annotationId', 'body'],
  },
  safe: false,
}

export const KB_COMMENT_RESOLVE_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'kb_comment_resolve',
  label: 'KB Comment Resolve',
  description:
    'Resolve or reopen a comment or note thread. Defaults to resolving; pass ' +
    "state 'open' to reopen.",
  parameters: {
    type: 'object',
    properties: {
      annotationId: { type: 'string', description: 'Top-level comment or note id' },
      state: {
        type: 'string',
        enum: ['resolved', 'open'],
        description: "Target state (default 'resolved')",
      },
    },
    required: ['annotationId'],
  },
  safe: false,
}

export const KB_NOTE_ADD_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'kb_note_add',
  label: 'KB Note Add',
  description:
    'Add an inline note anchored to a passage of a knowledge-base page. Provide ' +
    'the exact quoted text to anchor to; it must appear verbatim in the current ' +
    'page body or the call fails. The note highlights that passage in the reader.',
  parameters: {
    type: 'object',
    properties: {
      pageId: { type: 'string', description: 'Knowledge-base page id' },
      quote: {
        type: 'string',
        description: 'Exact text from the page body to anchor the note to',
      },
      body: { type: 'string', description: 'Note text' },
    },
    required: ['pageId', 'quote', 'body'],
  },
  safe: false,
}

export const KB_COMMENT_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  KB_COMMENTS_LIST_TOOL_DEFINITION,
  KB_COMMENT_ADD_TOOL_DEFINITION,
  KB_COMMENT_REPLY_TOOL_DEFINITION,
  KB_COMMENT_RESOLVE_TOOL_DEFINITION,
  KB_NOTE_ADD_TOOL_DEFINITION,
]
