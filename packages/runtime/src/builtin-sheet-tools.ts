import type { BuiltinToolDefinition } from './builtin-tools-types.js'

/**
 * The spreadsheet tool surface.
 *
 * Three rules run through every definition here, and an agent that has read the
 * descriptions should not need to be told any of them twice:
 *
 * - **A sheet is named, a range is A1, and the two are separate arguments.**
 *   `Sheet1!B2` is refused by the shared A1 grammar on purpose, so a range can
 *   never disagree with the sheet it was addressed to.
 * - **Batch-first.** One call writes a block, one call restructures. A loop of
 *   single-cell writes is a loop of journal batches, versions and fan-outs.
 * - **Versioning is the safety net, not an approval gate.** Nothing here waits
 *   for a human. A version is saved automatically before anything destructive
 *   and at an agent run's first write to a page, and `sheet_versions restore`
 *   puts it back — which is why these tools can delete rows at all.
 *
 * docs/plans/2026-09-15-spreadsheets-ironcalc/agent-tools.md
 */

const pageId = {
  type: 'string',
  description: 'The spreadsheet document id (a knowledge page of kind `spreadsheet`)',
} as const

const sheet = {
  type: 'string',
  description: 'Sheet name, e.g. "Q3 Forecast". Omit for the first visible sheet.',
} as const

const range = {
  type: 'string',
  description:
    'A1 range on that sheet: "B2", "B2:D40", a whole column "B:D" or whole rows "3:7". '
    + 'Never sheet-qualified — the sheet is a separate argument.',
} as const

export const SHEET_DESCRIBE_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'sheet_describe',
  category: 'spreadsheets',
  summary: 'Describe a spreadsheet: its sheets, used ranges, filters and versions.',
  label: 'Sheet Describe',
  description:
    'Describe a spreadsheet without reading any cells: every sheet, its used range, '
    + 'size, frozen panes, whether it is hidden and its filter, plus the version '
    + 'history. Call this first — it tells you which sheet names and ranges exist.',
  parameters: { type: 'object', properties: { pageId }, required: ['pageId'] },
  safe: true,
}

export const SHEET_READ_RANGE_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'sheet_read_range',
  category: 'spreadsheets',
  summary: 'Read a rectangle of cells as values, raw contents or formulas.',
  label: 'Sheet Read Range',
  description:
    'Read cells from one sheet. Defaults to the used range as displayed values. '
    + 'Over 10,000 cells is refused with the count and a split that fits — read it '
    + 'in pages rather than guessing. Rows a filter hides are left out unless you '
    + 'ask for them.',
  parameters: {
    type: 'object',
    properties: {
      pageId,
      sheet,
      range,
      values: {
        type: 'string',
        enum: ['display', 'raw', 'formula'],
        description:
          'display: what a person sees (default). raw: the cell content — formula text '
          + 'for a formula cell, the literal otherwise. formula: formula text, or null.',
      },
      format: { type: 'string', enum: ['rows', 'csv'], description: 'Shape of the answer' },
      includeStyles: {
        type: 'boolean',
        description: 'Also return a parallel matrix of bold/italic/colour/number format',
      },
      includeHidden: {
        type: 'boolean',
        description: 'Include rows a filter is hiding (default false)',
      },
    },
    required: ['pageId'],
  },
  safe: true,
}

export const SHEET_FIND_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'sheet_find',
  category: 'spreadsheets',
  summary: 'Find cells matching a query across a workbook, sheet or range.',
  label: 'Sheet Find',
  description:
    'Find cells whose displayed value (or formula text, with inFormulas) matches a '
    + 'query. Searches the whole workbook unless you narrow it. Returns up to 200 '
    + 'addresses, which is how you locate a row without reading a whole sheet.',
  parameters: {
    type: 'object',
    properties: {
      pageId,
      query: { type: 'string', description: 'Text, or a regular expression with `regex`' },
      scope: { type: 'string', enum: ['sheet', 'workbook', 'range'] },
      sheet,
      range,
      matchCase: { type: 'boolean' },
      wholeCell: { type: 'boolean', description: 'The whole cell must equal the query' },
      regex: {
        type: 'boolean',
        description:
          'Treat the query as a regular expression. Nested quantifiers, backreferences '
          + 'and lookaround are refused.',
      },
      inFormulas: { type: 'boolean', description: 'Search formula text instead of values' },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    },
    required: ['pageId', 'query'],
  },
  safe: true,
}

export const SHEET_REPLACE_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'sheet_replace',
  category: 'spreadsheets',
  summary: 'Replace matching cell contents, first match only unless you ask for all.',
  label: 'Sheet Replace',
  description:
    'Replace matches of a query. By default it changes ONLY the first match and lists '
    + 'what else matched, so you can confirm before setting `all`. A replacement that '
    + 'would leave a formula the engine cannot parse is refused per cell and reported; '
    + 'the rest still land.',
  parameters: {
    type: 'object',
    properties: {
      pageId,
      query: { type: 'string' },
      replacement: { type: 'string' },
      all: { type: 'boolean', description: 'Replace every match in scope (default false)' },
      scope: { type: 'string', enum: ['sheet', 'workbook', 'range'] },
      sheet,
      range,
      matchCase: { type: 'boolean' },
      wholeCell: { type: 'boolean' },
      regex: { type: 'boolean' },
      inFormulas: { type: 'boolean' },
    },
    required: ['pageId', 'query', 'replacement'],
  },
  safe: false,
}

export const SHEET_WRITE_RANGE_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'sheet_write_range',
  category: 'spreadsheets',
  summary: 'Write a 2-D block of values or formulas in one batch.',
  label: 'Sheet Write Range',
  description:
    'Write a block of cells in one call. `range` is the top-left anchor ("B2") and '
    + '`rows` is row-major; null clears a cell. Strings starting with "=" are '
    + 'formulas and are evaluated by the same engine the browser runs, so the value '
    + 'you read back is the value the person sees. Blocks of 400 cells or fewer are '
    + 'answered with their evaluated values.',
  parameters: {
    type: 'object',
    properties: {
      pageId,
      sheet,
      range: { type: 'string', description: 'Top-left anchor cell, e.g. "B2"' },
      rows: {
        type: 'array',
        description: 'Row-major array of arrays. Strings, numbers, booleans or null.',
        items: { type: 'array', items: {} },
      },
      mode: {
        type: 'string',
        enum: ['overwrite', 'insertRowsBelow'],
        description:
          'overwrite (default) replaces what is there; insertRowsBelow first inserts '
          + 'as many rows as the block is tall, so nothing under it is lost.',
      },
      parseValues: {
        type: 'boolean',
        description:
          'Default true: "=SUM(A1:A2)" becomes a formula and "2026-01-31" a date. '
          + 'False forces every string to stay literal text.',
      },
    },
    required: ['pageId', 'rows'],
  },
  safe: false,
}

export const SHEET_FORMAT_RANGE_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'sheet_format_range',
  category: 'spreadsheets',
  summary: 'Style a range: weight, colour, alignment, number format, borders.',
  label: 'Sheet Format Range',
  description:
    'Apply formatting to a range, or clear it. Number formats are Excel patterns '
    + '("#,##0.00", "0%"). Colours are "#RRGGBB".',
  parameters: {
    type: 'object',
    properties: {
      pageId,
      sheet,
      range,
      style: {
        type: 'object',
        properties: {
          bold: { type: 'boolean' },
          italic: { type: 'boolean' },
          underline: { type: 'boolean' },
          strike: { type: 'boolean' },
          fontColor: { type: 'string' },
          background: { type: 'string' },
          fontSize: { type: 'number' },
          hAlign: { type: 'string', enum: ['left', 'center', 'right'] },
          vAlign: { type: 'string', enum: ['top', 'center', 'bottom'] },
          wrap: { type: 'boolean' },
          numberFormat: { type: 'string' },
          borders: { type: 'string', enum: ['none', 'all', 'outer'] },
        },
      },
      clear: { type: 'boolean', description: 'Clear existing formatting first' },
    },
    required: ['pageId'],
  },
  safe: false,
}

export const SHEET_STRUCTURE_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'sheet_structure',
  category: 'spreadsheets',
  summary: 'Insert, delete, move, hide, resize, freeze, sort or clear rows and columns.',
  label: 'Sheet Structure',
  description:
    'Change a sheet\'s shape. Rows and columns are addressed as spans ("3:7", "B:D") '
    + 'or as `range` plus `count`. Sorting keeps formatting with the row and keeps '
    + 'formulas meaning what they meant: a relative reference moves with its row, an '
    + 'absolute one stays. A version is saved first before a large delete, a clear or '
    + 'a sort, and the answer names it.',
  parameters: {
    type: 'object',
    properties: {
      pageId,
      sheet,
      action: {
        type: 'string',
        enum: [
          'insertRows', 'insertColumns', 'deleteRows', 'deleteColumns',
          'moveRows', 'moveColumns', 'hide', 'show', 'resize',
          'freeze', 'unfreeze', 'sort', 'clear',
        ],
      },
      range,
      count: { type: 'integer', description: 'How many rows/columns, or how many to freeze' },
      delta: { type: 'integer', description: 'For moveRows/moveColumns: how far, and which way' },
      size: { type: 'integer', description: 'For resize: the new height or width' },
      sort: {
        type: 'object',
        properties: {
          by: {
            type: 'array',
            items: { type: 'string' },
            description: 'Column letters, "-" for descending, e.g. ["C", "-D"]',
          },
          hasHeader: { type: 'boolean', description: 'Keep the first row where it is' },
        },
        required: ['by'],
      },
    },
    required: ['pageId', 'action'],
  },
  safe: false,
}

export const SHEET_FILTER_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'sheet_filter',
  category: 'spreadsheets',
  summary: 'Read, set, re-apply or clear a sheet\'s filter.',
  label: 'Sheet Filter',
  description:
    'The sheet\'s filter, which is the same one a person sees. `set` replaces it and '
    + 'applies it; `reapply` re-evaluates it after the data changed (editing a cell '
    + 'never re-filters on its own, so a row cannot vanish under somebody\'s cursor); '
    + '`clear` unhides exactly the rows this filter hid and leaves manual hides alone.',
  parameters: {
    type: 'object',
    properties: {
      pageId,
      sheet,
      action: { type: 'string', enum: ['get', 'set', 'clear', 'reapply'] },
      range: {
        type: 'string',
        description: 'For set: the table including its header row. Defaults to the used range.',
      },
      columns: {
        type: 'object',
        description:
          'For set, keyed by column letter: { "C": { "values": ["open", "blocked"] }, '
          + '"D": { "op": "gt", "value": 10 } }. Operators: eq, ne, gt, gte, lt, lte, '
          + 'contains, notContains, startsWith, endsWith, empty, notEmpty, between.',
      },
      sort: {
        type: 'object',
        properties: {
          by: { type: 'string', description: 'Column letter' },
          direction: { type: 'string', enum: ['asc', 'desc'] },
        },
        required: ['by'],
      },
    },
    required: ['pageId', 'action'],
  },
  safe: false,
}

export const SHEET_TABS_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'sheet_tabs',
  category: 'spreadsheets',
  summary: 'Add, rename, delete, duplicate, move, hide or unhide a sheet.',
  label: 'Sheet Tabs',
  description:
    'Manage the workbook\'s sheets. Deleting one saves a version first and is refused '
    + 'for the last visible sheet. Duplicating copies contents and formatting.',
  parameters: {
    type: 'object',
    properties: {
      pageId,
      action: {
        type: 'string',
        enum: ['add', 'rename', 'delete', 'duplicate', 'move', 'hide', 'unhide'],
      },
      name: { type: 'string', description: 'The sheet to act on, by name' },
      newName: { type: 'string', description: 'For add, rename and duplicate' },
      position: { type: 'integer', description: 'For move: the new tab index, 0-based' },
    },
    required: ['pageId', 'action'],
  },
  safe: false,
}

export const SHEET_CREATE_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'sheet_create',
  category: 'spreadsheets',
  summary: 'Create a spreadsheet document, optionally seeded or imported.',
  label: 'Sheet Create',
  description:
    'Create a spreadsheet in a knowledge space — the same place `kb_document_compose` '
    + 'writes a document. Seed it with `sheets`, or import an .xlsx/.csv message '
    + 'attachment with `fromAttachmentId` (the workbook is parsed in the background '
    + 'and the page is openable straight away).',
  parameters: {
    type: 'object',
    properties: {
      spaceId: { type: 'string', description: 'Knowledge space to create it in' },
      title: { type: 'string' },
      parentPageId: { type: 'string', description: 'File it under this page' },
      taskId: { type: 'string', description: 'Bind it to a ticket' },
      sheets: {
        type: 'array',
        description: 'Initial sheets, at most 10,000 cells in total',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            rows: { type: 'array', items: { type: 'array', items: {} } },
          },
        },
      },
      fromAttachmentId: {
        type: 'string',
        description: 'An .xlsx or .csv attachment to import instead of seeding rows',
      },
    },
    required: ['spaceId', 'title'],
  },
  safe: false,
}

export const SHEET_EXPORT_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'sheet_export',
  category: 'spreadsheets',
  summary: 'Export a spreadsheet as .xlsx or .csv, optionally posting it to a channel.',
  label: 'Sheet Export',
  description:
    'Render the workbook (or one stored version) as a file. With `postTo` the file is '
    + 'attached to a new message in that channel or thread; without it you get an '
    + 'attachment id.',
  parameters: {
    type: 'object',
    properties: {
      pageId,
      format: { type: 'string', enum: ['xlsx', 'csv'] },
      sheet: { type: 'string', description: 'For csv: which sheet' },
      versionId: { type: 'string', description: 'Export a stored version instead of the live one' },
      postTo: {
        type: 'object',
        properties: {
          channelId: { type: 'string' },
          threadId: { type: 'string' },
        },
      },
    },
    required: ['pageId', 'format'],
  },
  safe: false,
}

export const SHEET_VERSIONS_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'sheet_versions',
  category: 'spreadsheets',
  summary: 'List, save or restore a spreadsheet version.',
  label: 'Sheet Versions',
  description:
    'Version history, newest first. `save` names a snapshot; `restore` puts one back '
    + 'after saving the current state first, so the restore is itself reversible. This '
    + 'is how you undo your own edit — or anyone else\'s — and say which version you '
    + 'went back to.',
  parameters: {
    type: 'object',
    properties: {
      pageId,
      action: { type: 'string', enum: ['list', 'save', 'restore'] },
      comment: { type: 'string', description: 'For save: what this version is' },
      versionId: { type: 'string', description: 'For restore' },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
    required: ['pageId', 'action'],
  },
  safe: false,
}

export const SHEET_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  SHEET_DESCRIBE_TOOL_DEFINITION,
  SHEET_READ_RANGE_TOOL_DEFINITION,
  SHEET_FIND_TOOL_DEFINITION,
  SHEET_REPLACE_TOOL_DEFINITION,
  SHEET_WRITE_RANGE_TOOL_DEFINITION,
  SHEET_FORMAT_RANGE_TOOL_DEFINITION,
  SHEET_STRUCTURE_TOOL_DEFINITION,
  SHEET_FILTER_TOOL_DEFINITION,
  SHEET_TABS_TOOL_DEFINITION,
  SHEET_CREATE_TOOL_DEFINITION,
  SHEET_EXPORT_TOOL_DEFINITION,
  SHEET_VERSIONS_TOOL_DEFINITION,
]

export const SHEET_TOOL_IDS: ReadonlySet<string> = new Set(
  SHEET_TOOL_DEFINITIONS.map((tool) => tool.id),
)
