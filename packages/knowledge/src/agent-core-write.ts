import { Readable } from 'node:stream'

import type { PrismaClient } from '@prisma/client'
import {
  assertAgentFieldAuthority,
  type AgentEditActor,
  type FileService,
  type LedgerAttribution,
} from '@nessie/runtime'

import { ensureAgentDocsSpace } from './provisioning.js'
import { loadActiveAgentCoreDocuments, type ActiveCoreDocument } from './agent-core-documents.js'
import type { KnowledgeProvider } from './types.js'

const DEFAULT_CORE_TOKEN_BUDGET = 2_000

const estimatedTokens = (text: string): number => Math.ceil(text.length / 4)

const tokenBudget = (): number => {
  const value = Number.parseInt(process.env.NESSIE_AGENT_CORE_TOKEN_BUDGET ?? '', 10)
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_CORE_TOKEN_BUDGET
}

const deleteStaged = async (
  files: FileService,
  ids: readonly string[],
  organizationId: string,
  attribution: LedgerAttribution,
): Promise<void> => {
  await Promise.all(ids.map((id) => files.delete(id, organizationId, attribution).catch(() => undefined)))
}

const stage = async (
  files: FileService,
  input: {
    attribution: LedgerAttribution
    organizationId: string
    projectId: string
    role: 'identity' | 'working_rules'
    spaceId: string
    text: string
    userId: string
  },
): Promise<string> => {
  const body = Object.assign(Readable.from([Buffer.from(input.text, 'utf8')]), { truncated: false })
  const stored = await files.store({
    attribution: input.attribution,
    body,
    filename: input.role === 'identity' ? 'Identity.md' : 'Working style.md',
    mime: 'text/markdown; charset=utf-8',
    organizationId: input.organizationId,
    scope: { projectId: input.projectId, spaceId: input.spaceId },
    uploaderId: input.userId,
  })
  if (!body.truncated) return stored.attachment.id
  await deleteStaged(files, [stored.attachment.id], input.organizationId, input.attribution)
  throw new Error('Core instruction upload exceeded the permitted file size')
}

const readCore = async (
  prisma: PrismaClient,
  files: FileService,
  agentId: string,
  organizationId: string,
): Promise<ActiveCoreDocument[]> => loadActiveAgentCoreDocuments(prisma, {
  agentId,
  organizationId,
  readMarkdownAttachment: async (attachmentId, tenantId) => {
    const opened = await files.openStream(attachmentId, tenantId)
    return opened?.stream ?? null
  },
})

export type CanonicalAgentCore = {
  documents: ActiveCoreDocument[]
  estimatedTokens: number
  speakingStyle: string
  systemPrompt: string
}

const toCanonical = (documents: ActiveCoreDocument[]): CanonicalAgentCore => {
  const identity = documents.find((document) => document.role === 'identity')?.markdown ?? ''
  const workingRules = documents.find((document) => document.role === 'working_rules')?.markdown ?? ''
  return {
    documents,
    estimatedTokens: estimatedTokens(identity) + estimatedTokens(workingRules),
    speakingStyle: workingRules,
    systemPrompt: identity,
  }
}

/**
 * Read the active, published core. Callers use this instead of Agent's retired
 * text columns once the migration marker exists.
 */
export const readCanonicalAgentCore = async (
  prisma: PrismaClient,
  files: FileService,
  input: { agentId: string; organizationId: string },
): Promise<CanonicalAgentCore | null> => {
  const marker = await prisma.agentCoreDocumentMigration.findUnique({
    where: { agentId: input.agentId }, select: { id: true },
  })
  if (!marker) return null
  return toCanonical(await readCore(prisma, files, input.agentId, input.organizationId))
}

/**
 * Applies a deliberate human core patch through FileService and the provider's
 * atomic published-version writer. The live UOA-backed agent-field decision is
 * made before any bytes are staged; ordinary notebook write access is not an
 * authority for this path.
 */
export const writeCanonicalAgentCore = async (
  prisma: PrismaClient,
  provider: KnowledgeProvider,
  files: FileService,
  input: {
    actor: AgentEditActor
    agentId: string
    attribution: LedgerAttribution
    organizationId: string
    projectId: string
    speakingStyle?: string | null
    systemPrompt?: string
    userId: string
  },
): Promise<CanonicalAgentCore> => {
  if (!provider.updateAgentCoreDocuments) {
    throw new Error('The active knowledge provider cannot update agent core documents')
  }
  const agent = await prisma.agent.findFirst({
    where: { id: input.agentId, organizationId: input.organizationId },
    select: {
      id: true,
      name: true,
      organizationId: true,
      ownerUserId: true,
      projectId: true,
      speakingStyle: true,
      systemManaged: true,
      systemPrompt: true,
      todosEnabled: true,
      visibility: true,
    },
  })
  if (!agent || !agent.projectId || agent.projectId !== input.projectId) {
    throw new Error('Agent is unavailable for core document editing')
  }
  await assertAgentFieldAuthority(prisma, input.actor, agent, {})
  const home = await ensureAgentDocsSpace(prisma, {
    agentId: agent.id, agentName: agent.name, organizationId: input.organizationId, projectId: input.projectId,
  })
  let existing = await readCanonicalAgentCore(prisma, files, {
    agentId: input.agentId, organizationId: input.organizationId,
  })
  if (!existing) {
    if (!provider.migrateAgentCoreDocuments) {
      throw new Error('The active knowledge provider cannot atomically migrate agent core documents')
    }
    const legacyEstimate = estimatedTokens(agent.systemPrompt ?? '') + estimatedTokens(agent.speakingStyle ?? '')
    if (legacyEstimate > tokenBudget()) {
      throw new Error(`Core instructions estimate ${legacyEstimate} tokens, above the ${tokenBudget()} token limit`)
    }
    const migrationDrafts: { attachmentId: string; role: 'identity' | 'working_rules' }[] = []
    try {
      if (agent.systemPrompt || agent.speakingStyle) {
        for (const role of ['identity', 'working_rules'] as const) {
          migrationDrafts.push({
            attachmentId: await stage(files, {
              ...input,
              role,
              spaceId: home.spaceId,
              text: role === 'identity' ? agent.systemPrompt ?? '' : agent.speakingStyle ?? '',
            }),
            role,
          })
        }
      }
      const migrated = await provider.migrateAgentCoreDocuments({
        agentId: input.agentId,
        authorId: input.userId,
        drafts: migrationDrafts,
        organizationId: input.organizationId,
        projectId: input.projectId,
        spaceId: home.spaceId,
      })
      if (migrated.kind === 'stale') throw new Error('Agent instructions changed while the core was being migrated')
      if (migrated.kind === 'already_migrated') {
        await deleteStaged(
          files,
          migrationDrafts.map((draft) => draft.attachmentId),
          input.organizationId,
          input.attribution,
        )
      }
    } catch (error) {
      await deleteStaged(
        files,
        migrationDrafts.map((draft) => draft.attachmentId),
        input.organizationId,
        input.attribution,
      )
      throw error
    }
    existing = await readCanonicalAgentCore(prisma, files, {
      agentId: input.agentId, organizationId: input.organizationId,
    })
    if (!existing) throw new Error('Agent core migration did not complete')
  }
  if (input.systemPrompt === undefined && input.speakingStyle === undefined) return existing
  const systemPrompt = input.systemPrompt === undefined ? existing.systemPrompt : input.systemPrompt
  const speakingStyle = input.speakingStyle === undefined ? existing.speakingStyle : input.speakingStyle ?? ''
  const estimate = estimatedTokens(systemPrompt) + estimatedTokens(speakingStyle)
  if (estimate > tokenBudget()) {
    throw new Error(`Core instructions estimate ${estimate} tokens, above the ${tokenBudget()} token limit`)
  }
  const byRole = new Map(existing.documents.map((document) => [document.role, document]))
  const roles: ('identity' | 'working_rules')[] = existing.documents.length === 0
    ? ['identity', 'working_rules']
    : [
        ...(input.systemPrompt === undefined ? [] : ['identity' as const]),
        ...(input.speakingStyle === undefined ? [] : ['working_rules' as const]),
      ]
  const drafts: { attachmentId: string; expectedPublishedVersionId?: string; role: 'identity' | 'working_rules' }[] = []
  try {
    for (const role of roles) {
      const text = role === 'identity' ? systemPrompt : speakingStyle
      drafts.push({
        attachmentId: await stage(files, { ...input, role, spaceId: home.spaceId, text }),
        ...(byRole.get(role) ? { expectedPublishedVersionId: byRole.get(role)!.versionId } : {}),
        role,
      })
    }
    const result = await provider.updateAgentCoreDocuments({
      agentId: input.agentId, authorId: input.userId, drafts, organizationId: input.organizationId,
      projectId: input.projectId, spaceId: home.spaceId,
    })
    if (result.kind === 'stale') throw new Error('Agent instructions changed while you were editing; reload and retry')
  } catch (error) {
    await deleteStaged(files, drafts.map((draft) => draft.attachmentId), input.organizationId, input.attribution)
    throw error
  }
  return toCanonical(await readCore(prisma, files, input.agentId, input.organizationId))
}
