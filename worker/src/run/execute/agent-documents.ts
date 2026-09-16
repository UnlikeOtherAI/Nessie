import type { PrismaClient } from '@prisma/client'
import { ensureAgentDocsSpace } from '@nessie/knowledge'

// Holding any of these means the agent can put content into the knowledge
// base, which is what earns it a documents home to put it in. `sheet_create`
// belongs here for exactly the same reason `kb_document_compose` does: a
// spreadsheet is a knowledge page, and an agent that can make one needs to be
// told where its own space is rather than guessing a space id.
const KB_WRITE_TOOL_IDS = new Set([
  'kb_draft_write',
  'kb_document_compose',
  'kb_document_edit',
  'kb_file',
  'sheet_create',
])

const DOCUMENTS_PROMPT_TOOL_IDS = [
  'kb_list',
  'kb_search',
  'kb_document_compose',
  'kb_document_edit',
]

/**
 * The second arm: an agent given the spreadsheet tools has a documents home to
 * be told about even when it holds none of the prose tools above.
 *
 * A spreadsheet is a knowledge page like any other, so it is created in the
 * same space — and an agent that was never handed the space id guesses one, or
 * asks. `sheet_read_range` sits in the list because describe-then-read-then-
 * write is the order these tools are meant to be used in, and an agent with
 * only `sheet_create` and `sheet_write_range` would have no way to check its
 * own work.
 */
const SPREADSHEET_PROMPT_TOOL_IDS = [
  'sheet_create',
  'sheet_read_range',
  'sheet_write_range',
]

export type AgentDocumentsHome = {
  spaceId: string
  title: string
}

export type AgentDocumentsPromptFacts = AgentDocumentsHome & {
  hasDocumentTools: boolean
  /** Whether the assembled toolset can work in spreadsheets. */
  hasSpreadsheetTools?: boolean
}

export const hasKbWriteTools = (toolIds: ReadonlySet<string>): boolean =>
  [...toolIds].some((toolId) => KB_WRITE_TOOL_IDS.has(toolId))

export const hasSpreadsheetPromptTools = (toolIds: ReadonlySet<string>): boolean =>
  SPREADSHEET_PROMPT_TOOL_IDS.every((toolId) => toolIds.has(toolId))

export const hasDocumentsPromptTools = (toolIds: ReadonlySet<string>): boolean =>
  DOCUMENTS_PROMPT_TOOL_IDS.every((toolId) => toolIds.has(toolId))
  || hasSpreadsheetPromptTools(toolIds)

/**
 * Resolve a documents home only for an agent whose assembled toolset can write
 * KB content. ensureAgentDocsSpace owns the indexed lookup and the locked
 * create race, so setup does not race a separate unprotected read.
 */
export const resolveAgentDocumentsHome = async (
  prisma: PrismaClient,
  input: {
    agentId: string
    agentName: string
    organizationId: string
    projectId: string
  },
): Promise<AgentDocumentsHome> => {
  const { spaceId } = await ensureAgentDocsSpace(prisma, input)
  return { spaceId, title: `${input.agentName} — Documents` }
}

/** Structural toolset-only prompt block; it never interprets message content. */
export const buildAgentDocumentsBlock = (
  facts: AgentDocumentsPromptFacts,
): string | null => {
  if (!facts.hasDocumentTools) return null
  return [
    'Your documents:',
    `- Home space: \`${facts.spaceId}\` (${facts.title}). Review it with \`kb_list\` / \`kb_search\`; `
      + 'use `kb_document_compose` to write a new document and `kb_document_edit` to revise one. '
      + 'Use this injected id; never guess a space id.',
    ...(facts.hasSpreadsheetTools
      ? [
        '- Spreadsheets: create one with `sheet_create` in the same home. Describe, then '
          + 'read, before you write; ranges are A1 and the sheet is a separate argument. A '
          + 'version is saved before anything destructive, and `sheet_versions restore` '
          + 'undoes it.',
      ]
      : []),
  ].join('\n')
}
