import { Readable } from 'node:stream'

import { ensureAgentDocsSpace, type KnowledgeProvider } from '@nessie/knowledge'
import type { FileService, LedgerAttribution } from '@nessie/runtime'
import type { PrismaClient } from '@prisma/client'

const DEFAULT_CORE_TOKEN_BUDGET = 2_000

const coreTokenBudget = (): number => {
  const configured = Number.parseInt(process.env.NESSIE_AGENT_CORE_TOKEN_BUDGET ?? '', 10)
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_CORE_TOKEN_BUDGET
}

// This admission seam has no model tokenizer. It is a conservative estimate,
// deliberately labelled as one in the Documents surface and never as exact.
const estimatedTokens = (text: string): number => Math.ceil(text.length / 4)

export type AgentCoreMigrationResult =
  | { state: 'active'; estimatedTokens: number }
  | { state: 'oversized'; estimatedTokens: number; tokenBudget: number }

type StagedCoreDraft = { attachmentId: string; role: 'identity' | 'working_rules' }

const deleteStaged = async (
  fileService: FileService,
  attachmentIds: readonly string[],
  organizationId: string,
  attribution: LedgerAttribution,
): Promise<void> => {
  await Promise.all(attachmentIds.map(async (attachmentId) => {
    await fileService.delete(attachmentId, organizationId, attribution).catch(() => undefined)
  }))
}

const stageCoreDraft = async (
  fileService: FileService,
  input: {
    attribution: LedgerAttribution
    organizationId: string
    projectId: string
    spaceId: string
    userId: string
    role: 'identity' | 'working_rules'
    text: string
  },
): Promise<string> => {
  const body = Object.assign(Readable.from([Buffer.from(input.text, 'utf8')]), { truncated: false })
  const stored = await fileService.store({
    attribution: input.attribution,
    body,
    filename: input.role === 'identity' ? 'Identity.md' : 'Working style.md',
    mime: 'text/markdown; charset=utf-8',
    organizationId: input.organizationId,
    scope: { projectId: input.projectId, spaceId: input.spaceId },
    uploaderId: input.userId,
  })
  if (!body.truncated) return stored.attachment.id
  await deleteStaged(fileService, [stored.attachment.id], input.organizationId, input.attribution)
  throw new Error('Core instruction upload exceeded the permitted file size')
}

/**
 * Converts legacy root-agent text through the provider's atomic core writer.
 * FileService bytes are deleted unless the transaction commits.
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
  if (!provider.migrateAgentCoreDocuments) {
    throw new Error('The active knowledge provider cannot atomically migrate agent core documents')
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const agent = await prisma.agent.findFirst({
      where: { id: input.agentId, organizationId: input.organizationId, systemManaged: false },
      select: { id: true, name: true, speakingStyle: true, systemPrompt: true },
    })
    if (!agent) throw new Error('Agent is unavailable for core document migration')
    const estimate = estimatedTokens(agent.systemPrompt ?? '') + estimatedTokens(agent.speakingStyle ?? '')
    const tokenBudget = coreTokenBudget()
    if (estimate > tokenBudget) return { state: 'oversized', estimatedTokens: estimate, tokenBudget }
    const home = await ensureAgentDocsSpace(prisma, {
      agentId: agent.id,
      agentName: agent.name,
      organizationId: input.organizationId,
      projectId: input.projectId,
    })
    const marked = await prisma.agentCoreDocumentMigration.findUnique({
      where: { agentId: agent.id }, select: { id: true },
    })
    if (marked) return { state: 'active', estimatedTokens: estimate }

    const hasLegacyCore = (agent.systemPrompt ?? '').length > 0 || (agent.speakingStyle ?? '').length > 0
    const staged: StagedCoreDraft[] = []
    try {
      if (hasLegacyCore) {
        for (const draft of [
          { role: 'identity' as const, text: agent.systemPrompt ?? '' },
          { role: 'working_rules' as const, text: agent.speakingStyle ?? '' },
        ]) {
          staged.push({
            attachmentId: await stageCoreDraft(fileService, {
              ...input,
              role: draft.role,
              spaceId: home.spaceId,
              text: draft.text,
            }),
            role: draft.role,
          })
        }
      }
      const result = await provider.migrateAgentCoreDocuments({
        agentId: agent.id,
        authorId: input.userId,
        drafts: staged,
        organizationId: input.organizationId,
        projectId: input.projectId,
        spaceId: home.spaceId,
      })
      if (result.kind === 'migrated') return { state: 'active', estimatedTokens: estimate }
      await deleteStaged(
        fileService, staged.map((draft) => draft.attachmentId), input.organizationId, input.attribution,
      )
      if (result.kind === 'already_migrated') return { state: 'active', estimatedTokens: estimate }
    } catch (error) {
      await deleteStaged(
        fileService, staged.map((draft) => draft.attachmentId), input.organizationId, input.attribution,
      )
      throw error
    }
  }
  throw new Error('Agent instructions changed while documents were being prepared; retry the migration')
}
