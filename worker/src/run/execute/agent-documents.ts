import type { PrismaClient } from '@prisma/client'
import { ensureAgentDocsSpace } from '@nessie/knowledge'

const KB_WRITE_TOOL_IDS = new Set([
  'kb_draft_write',
  'kb_document_compose',
  'kb_document_edit',
  'kb_file',
])

const DOCUMENTS_PROMPT_TOOL_IDS = [
  'kb_list',
  'kb_search',
  'kb_document_compose',
  'kb_document_edit',
]

export type AgentDocumentsHome = {
  spaceId: string
  title: string
}

export type AgentDocumentsPromptFacts = AgentDocumentsHome & {
  hasDocumentTools: boolean
}

export const hasKbWriteTools = (toolIds: ReadonlySet<string>): boolean =>
  [...toolIds].some((toolId) => KB_WRITE_TOOL_IDS.has(toolId))

export const hasDocumentsPromptTools = (toolIds: ReadonlySet<string>): boolean =>
  DOCUMENTS_PROMPT_TOOL_IDS.every((toolId) => toolIds.has(toolId))

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
  ].join('\n')
}
