import { createHash } from 'node:crypto'

import { Prisma, type PrismaClient } from '@prisma/client'
import { KnowledgeConflictError } from './errors.js'
import { markdownProjectionForAttachment, indexVersionChunks, type NativeKnowledgeProviderOptions } from './native-version-writer.js'
import { mergeVersionDisclosure, persistVersionDisclosure } from './version-disclosure.js'
import { CORE_DOCUMENT_ROLES, coreDocumentFilename } from './agent-core-contract.js'
import type {
  AgentCoreDocumentUpdateInput,
  AgentCoreDocumentUpdateResult,
  AgentCoreMigrationInput,
  AgentCoreMigrationResult,
} from './types.js'

const REQUIRED_ROLES = CORE_DOCUMENT_ROLES

const sourceHash = (identity: string, workingRules: string): string =>
  createHash('sha256').update(JSON.stringify([identity, workingRules])).digest('hex')

const contentHash = (value: string): string => createHash('sha256').update(value).digest('hex')

const assertCompleteRoles = (roles: readonly string[]): void => {
  if (roles.length !== REQUIRED_ROLES.length || new Set(roles).size !== REQUIRED_ROLES.length
    || !REQUIRED_ROLES.every((role) => roles.includes(role))) {
    throw new KnowledgeConflictError('Core instructions must contain one AGENTS.md and one personality.md document')
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
    const [agent, documentProject] = await Promise.all([
      tx.agent.findFirst({
        where: { id: input.agentId, organizationId: input.organizationId, systemManaged: false },
        select: { id: true, speakingStyle: true, systemPrompt: true },
      }),
      tx.project.findFirst({
        where: { id: input.projectId, organizationId: input.organizationId },
        select: { id: true },
      }),
    ])
    if (!agent || !documentProject) {
      throw new KnowledgeConflictError('Agent document project is outside its organization')
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
          title: coreDocumentFilename(draft.role),
          visibility: space.visibility,
        },
      })
      const version = await tx.knowledgePageVersion.create({
        data: {
          attachmentId: draft.attachmentId,
          authorId: input.authorId,
          authorType: input.authorType,
          body: draft.projection.body,
          origin: 'legacy_migration',
          pageId: page.id,
          sourceContentHash: draft.projection.sourceContentHash,
          trust: 'unverified_import',
          versionNumber: 1,
        },
      })
      await persistVersionDisclosure(tx, {
        disclosure: draft,
        organizationId: input.organizationId,
        versionId: version.id,
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
          actorUserId: input.authorType === 'user' ? input.authorId : null,
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

/**
 * The only writer for active core documents after cutover.  The attachment
 * bytes have already passed through FileService; this transaction pins them to
 * a new immutable version and advances the published pointer under a version
 * CAS.  It deliberately never touches Agent.systemPrompt/speakingStyle.
 */
export const updateAgentCoreDocuments = async (
  prisma: PrismaClient,
  options: NativeKnowledgeProviderOptions,
  input: AgentCoreDocumentUpdateInput,
): Promise<AgentCoreDocumentUpdateResult> => {
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
    const [agent, documentProject] = await Promise.all([
      tx.agent.findFirst({
        where: { id: input.agentId, organizationId: input.organizationId, systemManaged: false },
        select: { id: true, speakingStyle: true, systemPrompt: true },
      }),
      tx.project.findFirst({
        where: { id: input.projectId, organizationId: input.organizationId },
        select: { id: true },
      }),
    ])
    if (!agent || !documentProject) {
      throw new KnowledgeConflictError('Agent document project is outside its organization')
    }
    if (agent.systemPrompt !== null || agent.speakingStyle !== null) {
      throw new KnowledgeConflictError('Agent core migration is not complete')
    }
    const marker = await tx.agentCoreDocumentMigration.findUnique({
      where: { agentId: input.agentId }, select: { documentCount: true },
    })
    if (!marker) throw new KnowledgeConflictError('Agent core migration is not complete')
    const mappings = await tx.agentCoreDocument.findMany({
      where: { agentId: input.agentId },
      include: {
        page: {
          include: { publishedVersion: { include: { basisScopes: true, disclosureSources: true } } },
        },
      },
    })
    const mappedByRole = new Map(mappings.map((mapping) => [mapping.role, mapping]))
    if (mappings.length === 0) {
      if (marker.documentCount !== 0) throw new KnowledgeConflictError('Agent core instructions are incomplete')
      assertCompleteRoles(projections.map((draft) => draft.role))
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
            createdBy: input.authorId, documentRole: draft.role, kind: 'file',
            organizationId: input.organizationId,
            position: await tx.knowledgePage.count({
              where: { parentPageId: null, spaceId: input.spaceId },
            }),
            projectId: input.projectId,
            sensitivityTier: space.sensitivityTier,
            spaceId: input.spaceId,
            teamId: space.teamId,
            title: coreDocumentFilename(draft.role),
            visibility: space.visibility,
          },
        })
        const version = await tx.knowledgePageVersion.create({ data: {
          attachmentId: draft.attachmentId,
          authorId: input.authorId,
          authorType: input.authorType,
          body: draft.projection.body,
          origin: input.authorType === 'agent' ? 'agent_authored' : 'user_authored',
          pageId: page.id,
          sourceContentHash: draft.projection.sourceContentHash,
          trust: input.authorType === 'agent' ? 'inferred' : 'explicitly_confirmed',
          versionNumber: 1,
        } })
        await persistVersionDisclosure(tx, {
          disclosure: draft, organizationId: input.organizationId, versionId: version.id,
        })
        await tx.knowledgePage.update({
          where: { id: page.id }, data: { publishedVersionId: version.id, status: 'published' },
        })
        await tx.agentCoreDocument.create({
          data: {
            agentId: input.agentId,
            legacySourceHash: null,
            migratedAt: new Date(),
            pageId: page.id,
            role: draft.role,
          },
        })
        await indexVersionChunks(tx, options, page, version)
        if (options.onPagePublished) {
          await options.onPagePublished(tx, {
            actorUserId: input.authorType === 'user' ? input.authorId : null,
            organizationId: input.organizationId, pageId: page.id,
            projectId: input.projectId, spaceId: input.spaceId, versionId: version.id,
          })
        }
        pageIds.push(page.id)
      }
      await tx.agentCoreDocumentMigration.update({
        where: { agentId: input.agentId }, data: { documentCount: pageIds.length },
      })
      return { kind: 'updated', pageIds }
    }
    assertCompleteRoles(mappings.map((mapping) => mapping.role))
    if (marker.documentCount !== mappings.length) {
      throw new KnowledgeConflictError('Agent core instructions are incomplete')
    }
    if (new Set(projections.map((draft) => draft.role)).size !== projections.length) {
      throw new KnowledgeConflictError('A core instruction role may be updated only once per operation')
    }
    // Validate every compare-and-swap before appending anything. Returning
    // `stale` after the first role advanced would otherwise commit half of a
    // two-file update and let the caller delete an attachment that the first
    // new published version now referenced.
    const prepared = projections.map((draft) => {
      const mapping = mappedByRole.get(draft.role)
      const previous = mapping?.page.publishedVersion
      if (!mapping || mapping.page.deletedAt || !previous || !draft.expectedPublishedVersionId
        || previous.id !== draft.expectedPublishedVersionId) return null
      return { draft, mapping, previous }
    })
    if (prepared.some((entry) => entry === null)) return { kind: 'stale' }
    const pageIds: string[] = []
    for (const entry of prepared) {
      if (!entry) continue
      const { draft, mapping, previous } = entry
      const version = await tx.knowledgePageVersion.create({ data: {
        attachmentId: draft.attachmentId,
        authorId: input.authorId,
        authorType: input.authorType,
        body: draft.projection.body,
        origin: input.authorType === 'agent' ? 'agent_authored' : 'user_authored',
        pageId: mapping.pageId,
        sourceContentHash: draft.projection.sourceContentHash,
        trust: input.authorType === 'agent' ? 'inferred' : 'explicitly_confirmed',
        versionNumber: previous.versionNumber + 1,
      } })
      await persistVersionDisclosure(tx, {
        disclosure: mergeVersionDisclosure(previous, undefined),
        organizationId: input.organizationId,
        versionId: version.id,
      })
      const advanced = await tx.knowledgePage.updateMany({
        where: { id: mapping.pageId, publishedVersionId: previous.id },
        data: { publishedVersionId: version.id, revision: { increment: 1 }, status: 'published' },
      })
      if (advanced.count !== 1) return { kind: 'stale' }
      await indexVersionChunks(tx, options, mapping.page, version)
      if (options.onPagePublished) {
        await options.onPagePublished(tx, {
          actorUserId: input.authorType === 'user' ? input.authorId : null,
          organizationId: input.organizationId,
          pageId: mapping.pageId,
          projectId: input.projectId,
          spaceId: input.spaceId,
          versionId: version.id,
        })
      }
      pageIds.push(mapping.pageId)
    }
    return { kind: 'updated', pageIds }
  })
}
