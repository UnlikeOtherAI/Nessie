import { createHash } from 'node:crypto'

import { Prisma, type PrismaClient } from '@prisma/client'
import { KnowledgeConflictError } from './errors.js'
import { markdownProjectionForAttachment, indexVersionChunks, type NativeKnowledgeProviderOptions } from './native-version-writer.js'
import { persistVersionDisclosure } from './version-disclosure.js'
import type { AgentCoreMigrationInput, AgentCoreMigrationResult } from './types.js'

const REQUIRED_ROLES = ['identity', 'working_rules'] as const

const sourceHash = (identity: string, workingRules: string): string =>
  createHash('sha256').update(JSON.stringify([identity, workingRules])).digest('hex')

const contentHash = (value: string): string => createHash('sha256').update(value).digest('hex')

const assertCompleteRoles = (roles: readonly string[]): void => {
  if (roles.length !== REQUIRED_ROLES.length || new Set(roles).size !== REQUIRED_ROLES.length
    || !REQUIRED_ROLES.every((role) => roles.includes(role))) {
    throw new KnowledgeConflictError('Core instructions must contain one Identity and one Working style document')
  }
}

/**
 * Atomically makes staged Markdown attachments the only active core authority.
 * FileService owns the bytes before this transaction begins; a caller removes
 * those staged attachments if this transaction does not commit.
 */
export const migrateAgentCoreDocuments = async (
  prisma: PrismaClient,
  options: NativeKnowledgeProviderOptions,
  input: AgentCoreMigrationInput,
): Promise<AgentCoreMigrationResult> => {
  const projections = await Promise.all(input.drafts.map(async (draft) => {
    const projection = await markdownProjectionForAttachment(
      prisma, options, input.organizationId, draft.attachmentId,
    )
    if (!projection) throw new KnowledgeConflictError('Core instructions must be Markdown files')
    return { ...draft, projection }
  }))

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtext(${input.agentId}), hashtext('agent_core_migration'))
    `)
    const agent = await tx.agent.findFirst({
      where: { id: input.agentId, organizationId: input.organizationId, systemManaged: false },
      select: { id: true, projectId: true, speakingStyle: true, systemPrompt: true },
    })
    if (!agent || agent.projectId !== input.projectId) {
      throw new KnowledgeConflictError('Agent is not in this document project')
    }
    const marker = await tx.agentCoreDocumentMigration.findUnique({
      where: { agentId: input.agentId }, select: { id: true },
    })
    if (marker) {
      if (agent.systemPrompt === null && agent.speakingStyle === null) return { kind: 'already_migrated' }
      throw new KnowledgeConflictError('Agent core migration marker conflicts with legacy instructions')
    }
    const mappings = await tx.agentCoreDocument.findMany({
      where: { agentId: input.agentId }, select: { role: true }, orderBy: { role: 'asc' },
    })
    if (mappings.length > 0) {
      assertCompleteRoles(mappings.map((mapping) => mapping.role))
      if (agent.systemPrompt !== null || agent.speakingStyle !== null) {
        throw new KnowledgeConflictError('Agent core migration is incomplete and needs repair')
      }
      await tx.agentCoreDocumentMigration.create({
        data: {
          agentId: input.agentId,
          documentCount: REQUIRED_ROLES.length,
          organizationId: input.organizationId,
          sourceHash: sourceHash('', ''),
        },
      })
      return { kind: 'already_migrated' }
    }
    const identity = agent.systemPrompt ?? ''
    const workingRules = agent.speakingStyle ?? ''
    const hasLegacyCore = identity.length > 0 || workingRules.length > 0
    if (!hasLegacyCore) {
      if (projections.length !== 0) return { kind: 'stale' }
      const cutover = await tx.agent.updateMany({
        where: {
          id: input.agentId,
          organizationId: input.organizationId,
          speakingStyle: agent.speakingStyle,
          systemPrompt: agent.systemPrompt,
        },
        data: { speakingStyle: null, systemPrompt: null },
      })
      if (cutover.count !== 1) throw new KnowledgeConflictError('Agent instructions changed during migration')
      await tx.agentCoreDocumentMigration.create({
        data: {
          agentId: input.agentId,
          documentCount: 0,
          organizationId: input.organizationId,
          sourceHash: sourceHash(identity, workingRules),
        },
      })
      return { kind: 'migrated', pageIds: [] }
    }
    assertCompleteRoles(projections.map((draft) => draft.role))
    const expectedHash = new Map([
      ['identity', contentHash(identity)],
      ['working_rules', contentHash(workingRules)],
    ])
    if (projections.some((draft) => draft.projection.sourceContentHash !== expectedHash.get(draft.role))) {
      return { kind: 'stale' }
    }
    const space = await tx.knowledgeSpace.findFirst({
      where: {
        id: input.spaceId,
        organizationId: input.organizationId,
        ownerAgentId: input.agentId,
        projectId: input.projectId,
        deletedAt: null,
      },
      select: { id: true, teamId: true, visibility: true, sensitivityTier: true },
    })
    if (!space) throw new KnowledgeConflictError('Agent document home is unavailable')
    const pageIds: string[] = []
    for (const draft of projections) {
      const page = await tx.knowledgePage.create({
        data: {
          createdBy: input.authorId,
          documentRole: draft.role,
          kind: 'file',
          organizationId: input.organizationId,
          position: await tx.knowledgePage.count({
            where: { parentPageId: null, spaceId: input.spaceId },
          }),
          projectId: input.projectId,
          sensitivityTier: space.sensitivityTier,
          spaceId: input.spaceId,
          teamId: space.teamId,
          title: draft.role === 'identity' ? 'Identity.md' : 'Working style.md',
          visibility: space.visibility,
        },
      })
      const version = await tx.knowledgePageVersion.create({
        data: {
          attachmentId: draft.attachmentId,
          authorId: input.authorId,
          authorType: 'user',
          body: draft.projection.body,
          origin: 'legacy_migration',
          pageId: page.id,
          sourceContentHash: draft.projection.sourceContentHash,
          trust: 'unverified_import',
          versionNumber: 1,
        },
      })
      await persistVersionDisclosure(tx, {
        disclosure: {}, organizationId: input.organizationId, versionId: version.id,
      })
      await tx.knowledgePage.update({
        where: { id: page.id }, data: { publishedVersionId: version.id, status: 'published' },
      })
      await tx.agentCoreDocument.create({
        data: {
          agentId: input.agentId,
          legacySourceHash: expectedHash.get(draft.role),
          migratedAt: new Date(),
          pageId: page.id,
          role: draft.role,
        },
      })
      await indexVersionChunks(tx, options, page, version)
      if (options.onPagePublished) {
        await options.onPagePublished(tx, {
          actorUserId: input.authorId,
          organizationId: input.organizationId,
          pageId: page.id,
          projectId: input.projectId,
          spaceId: input.spaceId,
          versionId: version.id,
        })
      }
      pageIds.push(page.id)
    }
    const cutover = await tx.agent.updateMany({
      where: {
        id: input.agentId,
        organizationId: input.organizationId,
        speakingStyle: agent.speakingStyle,
        systemPrompt: agent.systemPrompt,
      },
      data: { speakingStyle: null, systemPrompt: null },
    })
    if (cutover.count !== 1) throw new KnowledgeConflictError('Agent instructions changed during migration')
    await tx.agentCoreDocumentMigration.create({
      data: {
        agentId: input.agentId,
        documentCount: pageIds.length,
        organizationId: input.organizationId,
        sourceHash: sourceHash(identity, workingRules),
      },
    })
    return { kind: 'migrated', pageIds }
  })
}
