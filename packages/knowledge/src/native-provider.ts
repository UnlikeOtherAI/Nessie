import { Prisma, type PrismaClient } from '@prisma/client'
import { KnowledgeConflictError } from './errors.js'
import { mapPage, mapVersion, pageInclude, versionInclude } from './native-mappers.js'
import { listNativeRecentPages } from './native-recent-pages.js'
import { searchNativePages } from './native-search.js'
import { searchNativePagesHybrid } from './native-search-hybrid.js'
import {
  addFileVersion,
  createPage,
  fetchPage,
  getMutablePage,
  indexVersionChunks,
  restoreVersion,
  updatePage,
  type NativeKnowledgeProviderOptions,
} from './native-version-writer.js'
import { migrateAgentCoreDocuments, updateAgentCoreDocuments } from './agent-core-migration.js'
import {
  archiveSpace,
  createSpace,
  getSpace,
  listSpaces,
  updateSpace,
} from './native-space-operations.js'
import { KnowledgePageRevisionConflictError } from './types.js'
import type {
  KnowledgePageTreeNode,
  KnowledgeProvider,
  ListPagesInput,
  MovePageInput,
  PublishPageInput,
} from './types.js'

export type {
  KnowledgePagePublishedEvent,
  KnowledgeVersionIndexedEvent,
  NativeKnowledgeProviderOptions,
} from './native-version-writer.js'

const nativeCapabilities = {
  canWrite: true,
  canIncrementalSync: false,
  supportsNativeSearch: true,
  supportsServerSideACL: true,
  supportsVersionHistory: true,
  supportsHierarchicalPages: true,
  supportsDeterministicSearch: true,
} as const

const assertMoveDoesNotCycle = async (
  tx: Prisma.TransactionClient,
  organizationId: string,
  pageId: string,
  parentPageId: string | null | undefined,
): Promise<boolean> => {
  let nextParentId = parentPageId ?? null
  while (nextParentId) {
    if (nextParentId === pageId) return false
    const parent = await tx.knowledgePage.findFirst({
      where: { id: nextParentId, organizationId },
      select: { parentPageId: true },
    })
    nextParentId = parent?.parentPageId ?? null
  }
  return true
}

const lockKnowledgeTreeMoves = async (
  tx: Prisma.TransactionClient,
  spaceId: string,
): Promise<void> => {
  await tx.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtext(${spaceId}), hashtext('knowledge_tree_move'))
  `)
}

const archivePage = async (
  prisma: PrismaClient,
  organizationId: string,
  pageId: string,
) => {
  await prisma.knowledgePage.updateMany({
    where: { id: pageId, organizationId, deletedAt: null },
    data: { status: 'archived' },
  })
  return fetchPage(prisma, organizationId, pageId)
}

const listPages = async (
  prisma: PrismaClient,
  input: ListPagesInput,
): Promise<KnowledgePageTreeNode[]> => {
  const pages = await prisma.knowledgePage.findMany({
    where: {
      organizationId: input.organizationId,
      spaceId: input.spaceId,
      deletedAt: null,
      ...(input.includeArchived ? {} : { status: { not: 'archived' as const } }),
    },
    include: pageInclude,
    orderBy: [{ parentPageId: 'asc' }, { position: 'asc' }, { title: 'asc' }],
  })
  const childrenByParent = new Map<string | null, string[]>()
  for (const page of pages) {
    const key = page.parentPageId ?? null
    childrenByParent.set(key, [...(childrenByParent.get(key) ?? []), page.id])
  }
  return pages.map((page) => {
    const record = mapPage(page)
    // Space tree views never render the body. Fetch it on demand when a page
    // is opened so listing a large space does not retain every document body.
    return {
      ...record,
      latestVersion: record.latestVersion ? { ...record.latestVersion, body: null } : null,
      childPageIds: childrenByParent.get(page.id) ?? [],
    }
  })
}

const movePage = async (
  prisma: PrismaClient,
  input: MovePageInput,
) =>
  prisma.$transaction(async (tx) => {
    const page = await getMutablePage(tx, input.organizationId, input.pageId)
    if (!page) return null
    // Serialize moves per space so cycle checks and the revision CAS observe
    // one stable tree while this transaction changes the parent relationship.
    await lockKnowledgeTreeMoves(tx, page.spaceId)
    if (input.expectedRevision !== undefined && page.revision !== input.expectedRevision) {
      throw new KnowledgePageRevisionConflictError(page.revision)
    }
    const validMove = await assertMoveDoesNotCycle(
      tx,
      input.organizationId,
      input.pageId,
      input.parentPageId,
    )
    if (!validMove) throw new KnowledgeConflictError('Cannot move a page below itself')
    if (input.parentPageId) {
      const parent = await tx.knowledgePage.findFirst({
        where: {
          id: input.parentPageId,
          organizationId: input.organizationId,
          spaceId: page.spaceId,
          deletedAt: null,
          status: { not: 'archived' },
        },
        select: { id: true },
      })
      if (!parent) return null
    }
    const moved = await tx.knowledgePage.updateMany({
      where: {
        id: input.pageId,
        organizationId: input.organizationId,
        ...(input.expectedRevision !== undefined ? { revision: input.expectedRevision } : {}),
      },
      data: {
        parentPageId: input.parentPageId ?? null,
        position: input.position,
        revision: { increment: 1 },
      },
    })
    if (moved.count === 0 && input.expectedRevision !== undefined) {
      const current = await getMutablePage(tx, input.organizationId, input.pageId)
      if (!current) return null
      throw new KnowledgePageRevisionConflictError(current.revision)
    }
    return fetchPage(tx, input.organizationId, input.pageId)
  })

const publishPage = async (
  prisma: PrismaClient,
  options: NativeKnowledgeProviderOptions,
  input: PublishPageInput,
) =>
  prisma.$transaction(async (tx) => {
    const page = await getMutablePage(tx, input.organizationId, input.pageId)
    if (!page) return null
    const latest = await tx.knowledgePageVersion.findFirst({
      where: { pageId: input.pageId },
      orderBy: { versionNumber: 'desc' },
    })
    if (!latest) return null
    await indexVersionChunks(tx, options, page, latest)
    const wasAlreadyPublished = page.status === 'published' && page.publishedVersionId === latest.id
    await tx.knowledgePage.update({
      where: { id: input.pageId },
      data: { publishedVersionId: latest.id, status: 'published' },
    })
    if (!wasAlreadyPublished && options.onPagePublished) {
      await options.onPagePublished(tx, {
        actorUserId: input.actorUserId ?? null,
        organizationId: input.organizationId,
        pageId: page.id,
        projectId: page.projectId,
        spaceId: page.spaceId,
        versionId: latest.id,
      })
    }
    return fetchPage(tx, input.organizationId, input.pageId)
  })

export const createNativeKnowledgeProvider = (
  prisma: PrismaClient,
  options: NativeKnowledgeProviderOptions = {},
): KnowledgeProvider => ({
  capabilities: nativeCapabilities,
  id: 'native:first-party',
  kind: 'first_party',
  addFileVersion: (input) => addFileVersion(prisma, options, input),
  archivePage: (organizationId, pageId) => archivePage(prisma, organizationId, pageId),
  archiveSpace: (organizationId, spaceId) => archiveSpace(prisma, organizationId, spaceId),
  createPage: (input) => createPage(prisma, options, input),
  createSpace: (input) => createSpace(prisma, input),
  getPage: fetchPage.bind(null, prisma),
  getSpace: (organizationId, spaceId) => getSpace(prisma, organizationId, spaceId),
  listPages: (input) => listPages(prisma, input),
  migrateAgentCoreDocuments: (input) => migrateAgentCoreDocuments(prisma, options, input),
  updateAgentCoreDocuments: (input) => updateAgentCoreDocuments(prisma, options, input),
  listRecentPages: (input) => listNativeRecentPages(prisma, input),
  listSpaces: (input) => listSpaces(prisma, input),
  listVersions: async (organizationId, pageId) => {
    const page = await prisma.knowledgePage.findFirst({
      where: { id: pageId, organizationId, deletedAt: null },
      select: { id: true },
    })
    if (!page) return []
    const versions = await prisma.knowledgePageVersion.findMany({
      where: { pageId },
      orderBy: { versionNumber: 'desc' },
      include: versionInclude,
    })
    return versions
      .map((version) => mapVersion(version))
      .filter((version): version is NonNullable<typeof version> => version !== null)
  },
  movePage: (input) => movePage(prisma, input),
  publishPage: (input) => publishPage(prisma, options, input),
  restoreVersion: (input) => restoreVersion(prisma, options, input),
  searchPages: (input) => searchNativePages(prisma, input),
  searchPagesHybrid: (input) => searchNativePagesHybrid(prisma, input),
  updatePage: (pageId, input) => updatePage(prisma, options, pageId, input),
  updateSpace: (organizationId, spaceId, input) => updateSpace(prisma, organizationId, spaceId, input),
})

export const buildNativeSourceRef = (pageId: string, versionId: string | null): string =>
  versionId ? `kb://first-party/pages/${pageId}/versions/${versionId}` : `kb://first-party/pages/${pageId}`

export const buildSpaceSourceRef = (spaceId: string): string =>
  `kb://first-party/spaces/${spaceId}`
