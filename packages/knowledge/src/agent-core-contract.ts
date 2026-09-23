/**
 * Persisted role values stay stable; filenames are the human-facing contract.
 * A filename never confers authority — AgentCoreDocument.role does.
 */
export const CORE_DOCUMENT_ROLES = ['identity', 'working_rules'] as const

export type CoreDocumentRole = (typeof CORE_DOCUMENT_ROLES)[number]

export const CORE_DOCUMENT_FILENAMES: Record<CoreDocumentRole, string> = {
  identity: 'AGENTS.md',
  working_rules: 'personality.md',
}

export const coreDocumentFilename = (role: CoreDocumentRole): string =>
  CORE_DOCUMENT_FILENAMES[role]

