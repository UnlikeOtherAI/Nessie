import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'

import {
  createAgentCoreDocument,
  ensureAgentDocsSpace,
  type KnowledgeProvider,
} from '@nessie/knowledge'
import type { FileService, LedgerAttribution } from '@nessie/runtime'
import type { PrismaClient } from '@prisma/client'

import { storeFileWithRollback } from './knowledge-file-store.js'

const DEFAULT_CORE_TOKEN_BUDGET = 2_000

const coreTokenBudget = (): number => {
  const configured = Number.parseInt(process.env.NESSIE_AGENT_CORE_TOKEN_BUDGET ?? '', 10)
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_CORE_TOKEN_BUDGET
}

// Nessie currently has no provider tokenizer at this admission seam. The
// conservative estimate is intentionally labelled as such in callers; it is a
// preflight, never a claim that exact tokens were counted.
const estimatedTokens = (text: string): number => Math.ceil(text.length / 4)
const sourceHash = (text: string): string => createHash('sha256').update(text).digest('hex')

export type AgentCoreMigrationResult =
  | { state: 'active'; estimatedTokens: number }
  | { state: 'oversized'; estimatedTokens: number; tokenBudget: number }

/**
 * Converts legacy, user-authored agent text once. Each source is copied byte
 * for byte into a separate canonical Markdown file. If the combined core would
 * exceed the configured admission budget, the legacy fields remain the sole
 * authority until an authorized person reduces them; no truncation or partial
 * dual-write is permitted.
 */
export const migrateLegacyAgentCoreDocuments = async (
  prisma: PrismaClient,
  provider: KnowledgeProvider,
  fileService: FileService,
  input: {
    agentId: string
    attribution: LedgerAttribution
    organizationId: string
    projectId: string
    userId: string
  },
): Promise<AgentCoreMigrationResult> => {
  const agent = await prisma.agent.findFirst({
    where: { id: input.agentId, organizationId: input.organizationId, systemManaged: false },
    select: { id: true, name: true, speakingStyle: true, systemPrompt: true },
  })
  if (!agent) throw new Error('Agent is unavailable for core document migration')
  const core = [
    { role: 'identity' as const, text: agent.systemPrompt ?? '' },
    { role: 'working_rules' as const, text: agent.speakingStyle ?? '' },
  ].filter((entry) => entry.text.trim())
  const estimate = core.reduce((total, entry) => total + estimatedTokens(entry.text), 0)
  const tokenBudget = coreTokenBudget()
  if (estimate > tokenBudget) {
    return { state: 'oversized', estimatedTokens: estimate, tokenBudget }
  }
  const home = await ensureAgentDocsSpace(prisma, {
    agentId: agent.id,
    agentName: agent.name,
    organizationId: input.organizationId,
    projectId: input.projectId,
  })
  const existing = await prisma.agentCoreDocument.findMany({
    where: { agentId: agent.id },
    select: { role: true },
  })
  const mapped = new Set(existing.map((entry) => entry.role))
  for (const entry of core) {
    if (mapped.has(entry.role)) continue
    const filename = entry.role === 'identity' ? 'Identity.md' : 'Working style.md'
    const body = Object.assign(Readable.from([Buffer.from(entry.text, 'utf8')]), { truncated: false })
    await storeFileWithRollback(
      fileService,
      {
        attribution: input.attribution,
        body,
        filename,
        mime: 'text/markdown; charset=utf-8',
        organizationId: input.organizationId,
        scope: { projectId: input.projectId, spaceId: home.spaceId },
        uploaderId: input.userId,
      },
      (attachmentId) => createAgentCoreDocument(prisma, provider, {
        agentId: agent.id,
        attachmentId,
        authorId: input.userId,
        legacySourceHash: sourceHash(entry.text),
        organizationId: input.organizationId,
        origin: 'legacy_migration',
        projectId: input.projectId,
        role: entry.role,
        spaceId: home.spaceId,
      }),
    )
  }
  // This is the cutover: after every non-empty legacy source has its own core
  // mapping, the old columns cease to be writable or active. Empty values are
  // cleared too, so a future author cannot mistake them for a fallback.
  await prisma.agent.update({
    where: { id: agent.id },
    data: { speakingStyle: null, systemPrompt: null },
  })
  return { state: 'active', estimatedTokens: estimate }
}
