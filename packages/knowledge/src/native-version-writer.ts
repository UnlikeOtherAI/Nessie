import { createHash } from 'node:crypto'

import { Prisma, type PrismaClient } from '@prisma/client'
import { KnowledgeConflictError } from './errors.js'
import { replaceLabels } from './native-labels.js'
import { mapPage, mapVersion, pageInclude, versionInclude } from './native-mappers.js'
import { replaceKnowledgePageVersionChunks, type ChunkablePage } from './native-chunks.js'
import { replaceKnowledgePageLinks, resolveLinksToPage } from './native-links.js'
import {
  isMarkdownAttachment,
  projectMarkdownAttachment,
  type MarkdownAttachmentReader,
  type MarkdownProjection,
} from './markdown-projection.js'
import { KnowledgePageRevisionConflictError } from './types.js'
import { mergeVersionDisclosure, persistVersionDisclosure } from './version-disclosure.js'
import type {
  AddFileVersionInput,
  CreatePageInput,
  KnowledgePageRecord,
  KnowledgePageVersionRecord,
  RestorePageVersionInput,
  UpdatePageInput,
} from './types.js'

export type KnowledgeVersionIndexedEvent = {
  organizationId: string
  pageId: string
  versionId: string
}

export type KnowledgePagePublishedEvent = {
  actorUserId: string | null
  organizationId: string
  pageId: string
  projectId: string
  spaceId: string
  versionId: string
}

export type NativeKnowledgeProviderOptions = {
  // FileService is the sole byte authority. The native provider uses this
  // reader to derive Markdown projections and never accepts caller text next
  // to an attachment id as proof of what was stored.
  readMarkdownAttachment?: MarkdownAttachmentReader
  // Invoked inside the same transaction that wrote a version's chunk rows —
  // the api wires this to enqueue the `knowledge.embed` job, so a failed
  // enqueue rolls the save back instead of silently losing the embedding pass.
  onVersionChunksReplaced?: (
    tx: Prisma.TransactionClient,
    event: KnowledgeVersionIndexedEvent,
  ) => Promise<void>
  // Invoked inside the publication transaction after the page points at its
  // newly published version. The API owns recipient resolution and the queue
  // outbox because they are app-level attention policy, not knowledge storage.
  onPagePublished?: (
    tx: Prisma.TransactionClient,
    event: KnowledgePagePublishedEvent,
  ) => Promise<void>
}

type AttachmentLookupClient = Pick<Prisma.TransactionClient, 'attachment'>

const assertTaskBelongsToSpaceProject = async (
  client: Prisma.TransactionClient,
  organizationId: string,
  projectId: string,
  taskId: string | null | undefined,
): Promise<void> => {
  if (!taskId) return
  const task = await client.task.findFirst({
    where: { id: taskId, organizationId, projectId },
    select: { id: true },
  })
  if (!task) throw new KnowledgeConflictError('Ticket not found in this knowledge space project')
}

export const markdownProjectionForAttachment = async (
  client: AttachmentLookupClient,
  options: NativeKnowledgeProviderOptions,
  organizationId: string,
  attachmentId: string,
): Promise<MarkdownProjection | null> => {
  const attachment = await client.attachment.findUnique({
    where: { id: attachmentId },
    select: { filename: true, mime: true, organizationId: true },
  })
  if (!attachment || attachment.organizationId !== organizationId) {
    throw new KnowledgeConflictError('Knowledge file attachment was not found in this organization')
  }
  if (!isMarkdownAttachment(attachment)) return null
  if (!options.readMarkdownAttachment) {
    throw new KnowledgeConflictError('Markdown file versions require a FileService reader')
  }
  return projectMarkdownAttachment(options.readMarkdownAttachment, attachmentId, organizationId)
}

const VERSION_CREATE_MAX_ATTEMPTS = 3
const ARCHIVED_PAGE_MESSAGE = 'Archived pages are read-only'

export const fetchPage = async (
  client: PrismaClient | Prisma.TransactionClient,
  organizationId: string,
  pageId: string,
): Promise<KnowledgePageRecord | null> => {
  const page = await client.knowledgePage.findFirst({
    where: { id: pageId, organizationId, deletedAt: null },
    include: pageInclude,
  })
  return page ? mapPage(page) : null
}

/** Create a page and its initial version through the canonical writer path. */
export const createPage = async (
  prisma: PrismaClient,
  options: NativeKnowledgeProviderOptions,
  input: CreatePageInput,
): Promise<KnowledgePageRecord> => {
  const projection = input.attachmentId
    ? await markdownProjectionForAttachment(
        prisma, options, input.organizationId, input.attachmentId,
      )
    : null
  if (projection && (input.body !== undefined || input.bodyRef !== undefined)) {
    throw new KnowledgeConflictError(
      'Markdown attachment versions cannot supply an independent body',
    )
  }
  return prisma.$transaction(async (tx) => {
    const space = await tx.knowledgeSpace.findFirst({
      where: { id: input.spaceId, organizationId: input.organizationId, deletedAt: null },
    })
    if (!space) throw new Error('Knowledge space not found')
    await assertTaskBelongsToSpaceProject(tx, input.organizationId, space.projectId, input.taskId)
    if (input.parentPageId) {
      const parent = await tx.knowledgePage.findFirst({
        where: {
          id: input.parentPageId, organizationId: input.organizationId, spaceId: input.spaceId,
          deletedAt: null, status: { not: 'archived' },
        },
        select: { id: true },
      })
      if (!parent) throw new Error('Parent page not found')
    }
    const position = input.position ?? await tx.knowledgePage.count({
      where: { parentPageId: input.parentPageId ?? null, spaceId: input.spaceId },
    })
    const page = await tx.knowledgePage.create({
      data: {
        title: input.title,
        summary: input.summary ?? null,
        metadata: input.metadata as Prisma.InputJsonValue,
        documentRole: input.documentRole ?? 'knowledge',
        kind: input.kind ?? 'document',
        spaceId: input.spaceId,
        parentPageId: input.parentPageId ?? null,
        position,
        organizationId: input.organizationId,
        projectId: space.projectId,
        teamId: input.teamId ?? space.teamId,
        channelId: input.channelId ?? space.channelId,
        threadId: input.threadId ?? space.threadId,
        userId: input.userId ?? space.userId,
        visibility: input.visibility ?? space.visibility,
        sensitivityTier: input.sensitivityTier ?? space.sensitivityTier,
        privateToAgentId: input.privateToAgentId ?? space.privateToAgentId,
        taskId: input.taskId ?? null,
        createdBy: input.createdBy,
      },
    })
    await resolveLinksToPage(tx, {
      organizationId: input.organizationId,
      pageId: page.id,
      title: page.title,
    })
    const version = await tx.knowledgePageVersion.create({
      data: {
        pageId: page.id,
        versionNumber: 1,
        body: projection?.body ?? input.body ?? null,
        bodyRef: projection ? null : input.bodyRef ?? null,
        attachmentId: input.attachmentId ?? null,
        sourceContentHash: projection?.sourceContentHash ?? null,
        authorType: input.authorType,
        authorId: input.authorId,
        changeComment: input.changeComment ?? null,
        origin: input.origin ?? 'user_authored',
        trust: input.trust ?? 'unverified_import',
      },
      include: versionInclude,
    })
    await persistVersionDisclosure(tx, { disclosure: input, organizationId: input.organizationId, versionId: version.id })
    await indexVersionChunks(tx, options, page, version)
    await replaceLabels(tx, { labels: input.labels, organizationId: input.organizationId, pageId: page.id })
    const created = await fetchPage(tx, input.organizationId, page.id)
    if (!created) throw new Error('Created page could not be loaded')
    return created
  })
}

export type AgentCoreMigrationDraft = {
  attachmentId: string
  role: 'identity' | 'working_rules'
}

export type AgentCoreMigrationResult =
  | { kind: 'migrated'; pageIds: string[] }
  | { kind: 'already_migrated' }
  | { kind: 'stale' }

const legacyHash = (value: string): string => createHash('sha256').update(value).digest('hex')

/**
 * The one transaction that activates legacy agent text as core documents. Blob
 * bytes are staged through FileService before this starts; everything that can
 * make a document active — page, published version, mapping, and legacy CAS —
 * either commits together or is compensated by the caller's staged-file cleanup.
 */
export const migrateAgentCoreDocuments = async (
  prisma: PrismaClient,
  options: NativeKnowledgeProviderOptions,
  input: {
    agentId: string
    authorId: string
    drafts: AgentCoreMigrationDraft[]
    organizationId: string
    projectId: string
    spaceId: string
  },
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
    const expected = [
      { role: 'identity' as const, value: agent.systemPrompt ?? '' },
      { role: 'working_rules' as const, value: agent.speakingStyle ?? '' },
    ].filter((entry) => entry.value.trim())
    const expectedByRole = new Map(expected.map((entry) => [entry.role, legacyHash(entry.value)]))
    if (
      projections.length !== expectedByRole.size
      || projections.some((draft) => draft.projection.sourceContentHash !== expectedByRole.get(draft.role))
    ) return { kind: 'stale' }
    const mappings = await tx.agentCoreDocument.findMany({
      where: { agentId: input.agentId },
      select: { id: true },
    })
    if (mappings.length > 0) {
      // A completed migration has cleared its source columns. Anything else is
      // an interrupted historical state and must be repaired deliberately,
      // never made active beside a second authority.
      if (!agent.systemPrompt && !agent.speakingStyle) return { kind: 'already_migrated' }
      throw new KnowledgeConflictError('Agent core migration is incomplete and needs repair')
    }
    const pages: Array<{ id: string; role: 'identity' | 'working_rules'; versionId: string }> = []
    for (const draft of projections) {
      const position = await tx.knowledgePage.count({
        where: { parentPageId: null, spaceId: input.spaceId },
      })
      const title = draft.role === 'identity' ? 'Identity.md' : 'Working style.md'
      const page = await tx.knowledgePage.create({
        data: {
          createdBy: input.authorId,
          documentRole: draft.role,
          kind: 'file',
          organizationId: input.organizationId,
          position,
          projectId: input.projectId,
          sensitivityTier: space.sensitivityTier,
          spaceId: input.spaceId,
          teamId: space.teamId,
          title,
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
      await tx.knowledgePage.update({
        where: { id: page.id },
        data: { publishedVersionId: version.id, status: 'published' },
      })
      await tx.agentCoreDocument.create({
        data: {
          agentId: input.agentId,
          legacySourceHash: expectedByRole.get(draft.role) ?? null,
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
      pages.push({ id: page.id, role: draft.role, versionId: version.id })
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
    return { kind: 'migrated', pageIds: pages.map((page) => page.id) }
  })
}

export const nextVersionNumber = async (
  tx: Prisma.TransactionClient,
  pageId: string,
): Promise<number> => {
  const latest = await tx.knowledgePageVersion.findFirst({
    where: { pageId },
    orderBy: { versionNumber: 'desc' },
    select: { versionNumber: true },
  })
  return (latest?.versionNumber ?? 0) + 1
}

const isVersionNumberConflict = (error: unknown): boolean => {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false
  }
  const target = error.meta?.['target']
  if (Array.isArray(target)) {
    const columns = new Set(
      target.filter((value): value is string => typeof value === 'string'),
    )
    return (
      (columns.has('page_id') || columns.has('pageId')) &&
      (columns.has('version_number') || columns.has('versionNumber'))
    )
  }
  return (
    typeof target === 'string' &&
    (target.includes('knowledge_page_versions_page_version_key') ||
      (target.includes('page_id') && target.includes('version_number')))
  )
}

export const withVersionNumberRetry = async <T>(operation: () => Promise<T>): Promise<T> => {
  for (let attempt = 1; attempt <= VERSION_CREATE_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (!isVersionNumberConflict(error)) throw error
      if (attempt === VERSION_CREATE_MAX_ATTEMPTS) {
        throw new KnowledgeConflictError('Knowledge page version conflict')
      }
    }
  }
  throw new KnowledgeConflictError('Knowledge page version conflict')
}

export const getMutablePage = async (
  tx: Prisma.TransactionClient,
  organizationId: string,
  pageId: string,
) => {
  const page = await tx.knowledgePage.findFirst({
    where: { id: pageId, organizationId, deletedAt: null },
    select: {
      id: true,
      spaceId: true,
      status: true,
      organizationId: true,
      projectId: true,
      teamId: true,
      channelId: true,
      threadId: true,
      userId: true,
      visibility: true,
      sensitivityTier: true,
      privateToAgentId: true,
      publishedVersionId: true,
      revision: true,
      kind: true,
      taskId: true,
    },
  })
  if (!page) return null
  if (page.status === 'archived') throw new KnowledgeConflictError(ARCHIVED_PAGE_MESSAGE)
  return page
}

// The chunk write is the single indexing seam for every new version. Keeping
// links and embedding enqueueing behind its written gate preserves the
// transaction behavior while giving callers one writer hook to extend.
export const indexVersionChunks = async (
  tx: Prisma.TransactionClient,
  options: NativeKnowledgeProviderOptions,
  page: ChunkablePage,
  version: { body: string | null; id: string },
): Promise<void> => {
  // This written gate is shared by create/update/restore and publish. A
  // repeated publish of an already-indexed version must not rewrite chunks or
  // links that already reflect the version's body.
  const written = await replaceKnowledgePageVersionChunks(tx, { page, version })
  if (!written) return
  await replaceKnowledgePageLinks(tx, {
    organizationId: page.organizationId,
    sourcePageId: page.id,
    bodyHtml: version.body,
  })
  if (options.onVersionChunksReplaced) {
    await options.onVersionChunksReplaced(tx, {
      organizationId: page.organizationId,
      pageId: page.id,
      versionId: version.id,
    })
  }
}

export const restoreVersion = async (
  prisma: PrismaClient,
  options: NativeKnowledgeProviderOptions,
  input: RestorePageVersionInput,
) =>
  withVersionNumberRetry(() => prisma.$transaction(async (tx) => {
    const page = await getMutablePage(tx, input.organizationId, input.pageId)
    if (!page) return null
    const version = await tx.knowledgePageVersion.findFirst({
      where: { id: input.versionId, pageId: input.pageId },
      include: versionInclude,
    })
    if (!version) return null
    const current = await tx.knowledgePageVersion.findFirst({
      where: { pageId: input.pageId }, orderBy: { versionNumber: 'desc' }, include: versionInclude,
    })
    const projection = version.attachmentId
      ? await markdownProjectionForAttachment(tx, options, input.organizationId, version.attachmentId)
      : null
    const restored = await tx.knowledgePageVersion.create({
      data: {
        pageId: input.pageId,
        versionNumber: await nextVersionNumber(tx, input.pageId),
        body: projection?.body ?? version.body,
        bodyRef: projection ? null : version.bodyRef,
        attachmentId: version.attachmentId,
        sourceContentHash: projection?.sourceContentHash ?? version.sourceContentHash,
        authorType: input.authorType,
        authorId: input.authorId,
        changeComment: input.changeComment ?? `Restored version ${version.versionNumber}`,
        origin: input.origin ?? version.origin,
        trust: input.trust ?? version.trust,
      },
    })
    await persistVersionDisclosure(tx, {
      disclosure: mergeVersionDisclosure(current ?? undefined, mergeVersionDisclosure(version, input)),
      organizationId: input.organizationId, versionId: restored.id,
    })
    await indexVersionChunks(tx, options, page, restored)
    await tx.knowledgePage.update({ where: { id: input.pageId }, data: { status: 'draft' } })
    return fetchPage(tx, input.organizationId, input.pageId)
  }))

export const addFileVersion = async (
  prisma: PrismaClient,
  options: NativeKnowledgeProviderOptions,
  input: AddFileVersionInput,
): Promise<KnowledgePageVersionRecord | null> =>
  withVersionNumberRetry(async () => {
    const projection = await markdownProjectionForAttachment(
      prisma,
      options,
      input.organizationId,
      input.attachmentId,
    )
    return prisma.$transaction(async (tx) => {
      const page = await getMutablePage(tx, input.organizationId, input.pageId)
      if (!page) return null
      const latest = await tx.knowledgePageVersion.findFirst({
        where: { pageId: input.pageId },
        orderBy: { versionNumber: 'desc' },
        include: versionInclude,
      })
      if (input.expectedLatestVersionId && latest?.id !== input.expectedLatestVersionId) {
        throw new KnowledgeConflictError('The file changed after this Markdown editor opened')
      }
      const version = await tx.knowledgePageVersion.create({
        data: {
          pageId: input.pageId,
          versionNumber: await nextVersionNumber(tx, input.pageId),
          body: projection?.body ?? null,
          attachmentId: input.attachmentId,
          sourceContentHash: projection?.sourceContentHash ?? null,
          authorType: input.authorType,
          authorId: input.authorId,
          changeComment: input.changeComment ?? null,
          origin: input.origin ?? 'user_authored',
          trust: input.trust ?? 'unverified_import',
        },
        include: versionInclude,
      })
      await persistVersionDisclosure(tx, {
        disclosure: mergeVersionDisclosure(latest ?? undefined, input),
        organizationId: input.organizationId, versionId: version.id,
      })
      await tx.knowledgePage.update({ where: { id: input.pageId }, data: {} })
      await indexVersionChunks(tx, options, page, version)
      return mapVersion(version)
    })
  })

export const updatePage = async (
  prisma: PrismaClient,
  options: NativeKnowledgeProviderOptions,
  pageId: string,
  input: UpdatePageInput,
) =>
  withVersionNumberRetry(() => prisma.$transaction(async (tx) => {
    const existing = await getMutablePage(tx, input.organizationId, pageId)
    if (!existing) return null
    if (existing.kind === 'file' && (input.body !== undefined || input.bodyRef !== undefined)) {
      throw new KnowledgeConflictError('File versions must be created from their attachment bytes')
    }
    if (input.expectedRevision !== undefined && existing.revision !== input.expectedRevision) {
      throw new KnowledgePageRevisionConflictError(existing.revision)
    }
    const createsVersion = input.body !== undefined || input.bodyRef !== undefined
      || input.basisScopes !== undefined || input.disclosureSources !== undefined
      || input.title !== undefined || input.summary !== undefined || input.labels !== undefined
    if (createsVersion) {
      const previous = await tx.knowledgePageVersion.findFirst({
        where: { pageId }, orderBy: { versionNumber: 'desc' }, include: versionInclude,
      })
      const version = await tx.knowledgePageVersion.create({
        data: {
          pageId,
          versionNumber: await nextVersionNumber(tx, pageId),
          body: input.body ?? previous?.body ?? null,
          bodyRef: input.bodyRef ?? previous?.bodyRef ?? null,
          attachmentId: previous?.attachmentId ?? null,
          sourceContentHash: previous?.sourceContentHash ?? null,
          authorType: input.authorType,
          authorId: input.authorId,
          changeComment: input.changeComment ?? null,
          origin: input.origin ?? 'user_authored',
          trust: input.trust ?? 'unverified_import',
        },
      })
      await persistVersionDisclosure(tx, {
        disclosure: mergeVersionDisclosure(previous ?? undefined, input),
        organizationId: input.organizationId, versionId: version.id,
      })
      await indexVersionChunks(tx, options, existing, version)
    }
    const updated = await tx.knowledgePage.updateMany({
      where: {
        id: pageId,
        organizationId: input.organizationId,
        ...(input.expectedRevision !== undefined ? { revision: input.expectedRevision } : {}),
      },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        ...(input.sensitivityTier !== undefined ? { sensitivityTier: input.sensitivityTier } : {}),
        ...(createsVersion ? { status: 'draft' as const } : {}),
        revision: { increment: 1 },
      },
    })
    if (updated.count === 0 && input.expectedRevision !== undefined) {
      const current = await getMutablePage(tx, input.organizationId, pageId)
      if (!current) return null
      throw new KnowledgePageRevisionConflictError(current.revision)
    }
    if (input.title !== undefined) {
      await resolveLinksToPage(tx, { organizationId: input.organizationId, pageId, title: input.title })
    }
    await replaceLabels(tx, { labels: input.labels, organizationId: input.organizationId, pageId })
    return fetchPage(tx, input.organizationId, pageId)
  }))
