import { Prisma, type PrismaClient } from '@prisma/client'
import { replaceLabels } from './native-labels.js'
import { mapPage, mapSpace, mapVersion, pageInclude } from './native-mappers.js'
import { searchNativePages } from './native-search.js'
import { clampLimit, parseCursor, trimPage } from './pagination.js'
import type {
  KnowledgePageRecord,
  KnowledgePageTreeNode,
  KnowledgePageVersionRecord,
  KnowledgeProvider,
  ListPagesInput,
  MovePageInput,
  PublishPageInput,
  RestorePageVersionInput,
  UpdatePageInput,
} from './types.js'

const nativeCapabilities = {
  canWrite: true,
  canIncrementalSync: false,
  supportsNativeSearch: true,
  supportsServerSideACL: true,
  supportsVersionHistory: true,
  supportsHierarchicalPages: true,
  supportsDeterministicSearch: true,
} as const

const fetchPage = async (
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

const nextVersionNumber = async (
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

const assertMoveDoesNotCycle = async (
  tx: Prisma.TransactionClient,
  pageId: string,
  parentPageId: string | null | undefined,
): Promise<boolean> => {
  let nextParentId = parentPageId ?? null
  while (nextParentId) {
    if (nextParentId === pageId) return false
    const parent = await tx.knowledgePage.findUnique({
      where: { id: nextParentId },
      select: { parentPageId: true },
    })
    nextParentId = parent?.parentPageId ?? null
  }
  return true
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
  return pages.map((page) => ({
    ...mapPage(page),
    childPageIds: childrenByParent.get(page.id) ?? [],
  }))
}

const movePage = async (
  prisma: PrismaClient,
  input: MovePageInput,
) =>
  prisma.$transaction(async (tx) => {
    const page = await tx.knowledgePage.findFirst({
      where: { id: input.pageId, organizationId: input.organizationId, deletedAt: null },
      select: { id: true, spaceId: true },
    })
    if (!page) return null
    const validMove = await assertMoveDoesNotCycle(tx, input.pageId, input.parentPageId)
    if (!validMove) throw new Error('Cannot move a page below itself')
    if (input.parentPageId) {
      const parent = await tx.knowledgePage.findFirst({
        where: {
          id: input.parentPageId,
          organizationId: input.organizationId,
          spaceId: page.spaceId,
        },
        select: { id: true },
      })
      if (!parent) return null
    }
    await tx.knowledgePage.update({
      where: { id: input.pageId },
      data: {
        parentPageId: input.parentPageId ?? null,
        position: input.position,
      },
    })
    return fetchPage(tx, input.organizationId, input.pageId)
  })

const publishPage = async (
  prisma: PrismaClient,
  input: PublishPageInput,
) =>
  prisma.$transaction(async (tx) => {
    const page = await tx.knowledgePage.findFirst({
      where: { id: input.pageId, organizationId: input.organizationId, deletedAt: null },
      select: { id: true },
    })
    if (!page) return null
    const latest = await tx.knowledgePageVersion.findFirst({
      where: { pageId: input.pageId },
      orderBy: { versionNumber: 'desc' },
    })
    if (!latest) return null
    await tx.knowledgePage.update({
      where: { id: input.pageId },
      data: { publishedVersionId: latest.id, status: 'published' },
    })
    return fetchPage(tx, input.organizationId, input.pageId)
  })

const restoreVersion = async (
  prisma: PrismaClient,
  input: RestorePageVersionInput,
) =>
  prisma.$transaction(async (tx) => {
    const version = await tx.knowledgePageVersion.findFirst({
      where: {
        id: input.versionId,
        pageId: input.pageId,
        page: { organizationId: input.organizationId, deletedAt: null },
      },
    })
    if (!version) return null
    await tx.knowledgePageVersion.create({
      data: {
        pageId: input.pageId,
        versionNumber: await nextVersionNumber(tx, input.pageId),
        body: version.body,
        bodyRef: version.bodyRef,
        authorType: input.authorType,
        authorId: input.authorId,
        changeComment: input.changeComment ?? `Restored version ${version.versionNumber}`,
      },
    })
    await tx.knowledgePage.update({
      where: { id: input.pageId },
      data: { status: 'draft' },
    })
    return fetchPage(tx, input.organizationId, input.pageId)
  })

const updatePage = async (
  prisma: PrismaClient,
  pageId: string,
  input: UpdatePageInput,
) =>
  prisma.$transaction(async (tx) => {
    const existing = await tx.knowledgePage.findFirst({
      where: { id: pageId, organizationId: input.organizationId, deletedAt: null },
      select: { id: true },
    })
    if (!existing) return null
    const createsVersion = input.body !== undefined || input.bodyRef !== undefined
    if (createsVersion) {
      await tx.knowledgePageVersion.create({
        data: {
          pageId,
          versionNumber: await nextVersionNumber(tx, pageId),
          body: input.body ?? null,
          bodyRef: input.bodyRef ?? null,
          authorType: input.authorType,
          authorId: input.authorId,
          changeComment: input.changeComment ?? null,
        },
      })
    }
    await tx.knowledgePage.update({
      where: { id: pageId },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
        ...(input.metadata !== undefined
          ? { metadata: input.metadata as Prisma.InputJsonValue }
          : {}),
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        ...(input.sensitivityTier !== undefined
          ? { sensitivityTier: input.sensitivityTier }
          : {}),
        ...(createsVersion ? { status: 'draft' as const } : {}),
      },
    })
    await replaceLabels(tx, {
      labels: input.labels,
      organizationId: input.organizationId,
      pageId,
    })
    return fetchPage(tx, input.organizationId, pageId)
  })

export const createNativeKnowledgeProvider = (
  prisma: PrismaClient,
): KnowledgeProvider => ({
  capabilities: nativeCapabilities,
  id: 'native:first-party',
  kind: 'first_party',

  archivePage: (organizationId, pageId) => archivePage(prisma, organizationId, pageId),

  archiveSpace: async (organizationId, spaceId) => {
    const result = await prisma.knowledgeSpace.updateMany({
      where: { id: spaceId, organizationId, deletedAt: null },
      data: { deletedAt: new Date() },
    })
    if (result.count === 0) return null
    const space = await prisma.knowledgeSpace.findFirst({ where: { id: spaceId, organizationId } })
    return space ? mapSpace(space) : null
  },

  createPage: async (input) =>
    prisma.$transaction(async (tx) => {
      const space = await tx.knowledgeSpace.findFirst({
        where: { id: input.spaceId, organizationId: input.organizationId, deletedAt: null },
      })
      if (!space) throw new Error('Knowledge space not found')
      if (input.parentPageId) {
        const parent = await tx.knowledgePage.findFirst({
          where: {
            id: input.parentPageId,
            organizationId: input.organizationId,
            spaceId: input.spaceId,
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
          createdBy: input.createdBy,
        },
      })
      await tx.knowledgePageVersion.create({
        data: {
          pageId: page.id,
          versionNumber: 1,
          body: input.body ?? null,
          bodyRef: input.bodyRef ?? null,
          authorType: input.authorType,
          authorId: input.authorId,
          changeComment: input.changeComment ?? null,
        },
      })
      await replaceLabels(tx, {
        labels: input.labels,
        organizationId: input.organizationId,
        pageId: page.id,
      })
      const created = await fetchPage(tx, input.organizationId, page.id)
      if (!created) throw new Error('Created page could not be loaded')
      return created
    }),

  createSpace: async (input) => {
    const space = await prisma.knowledgeSpace.create({
      data: {
        name: input.name,
        description: input.description ?? null,
        metadata: input.metadata as Prisma.InputJsonValue,
        organizationId: input.organizationId,
        projectId: input.projectId,
        teamId: input.teamId ?? null,
        channelId: input.channelId ?? null,
        threadId: input.threadId ?? null,
        userId: input.userId ?? null,
        visibility: input.visibility ?? 'project',
        sensitivityTier: input.sensitivityTier ?? 'normal',
        privateToAgentId: input.privateToAgentId ?? null,
        createdBy: input.createdBy,
      },
    })
    return mapSpace(space)
  },

  getPage: fetchPage.bind(null, prisma),

  getSpace: async (organizationId, spaceId) => {
    const space = await prisma.knowledgeSpace.findFirst({
      where: { id: spaceId, organizationId, deletedAt: null },
    })
    return space ? mapSpace(space) : null
  },

  listPages: (input) => listPages(prisma, input),

  listSpaces: async (input) => {
    const limit = clampLimit(input.limit)
    const cursor = parseCursor(input.cursor)
    const spaces = await prisma.knowledgeSpace.findMany({
      where: {
        organizationId: input.organizationId,
        deletedAt: null,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(cursor
          ? {
              OR: [
                { updatedAt: { lt: cursor.cursorDate } },
                { updatedAt: cursor.cursorDate, id: { lt: cursor.cursorId } },
              ],
            }
          : {}),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    })
    return trimPage(spaces.map(mapSpace), limit)
  },

  listVersions: async (organizationId, pageId) => {
    const page = await prisma.knowledgePage.findFirst({
      where: { id: pageId, organizationId, deletedAt: null },
      select: { id: true },
    })
    if (!page) return []
    const versions = await prisma.knowledgePageVersion.findMany({
      where: { pageId },
      orderBy: { versionNumber: 'desc' },
    })
    return versions
      .map((version) => mapVersion(version))
      .filter((v): v is KnowledgePageVersionRecord => v !== null)
  },

  movePage: (input) => movePage(prisma, input),
  publishPage: (input) => publishPage(prisma, input),
  restoreVersion: (input) => restoreVersion(prisma, input),
  searchPages: (input) => searchNativePages(prisma, input),
  updatePage: (pageId, input) => updatePage(prisma, pageId, input),

  updateSpace: async (organizationId, spaceId, input) => {
    const result = await prisma.knowledgeSpace.updateMany({
      where: { id: spaceId, organizationId, deletedAt: null },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.metadata !== undefined
          ? { metadata: input.metadata as Prisma.InputJsonValue }
          : {}),
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        ...(input.sensitivityTier !== undefined
          ? { sensitivityTier: input.sensitivityTier }
          : {}),
      },
    })
    if (result.count === 0) return null
    const space = await prisma.knowledgeSpace.findFirst({
      where: { id: spaceId, organizationId, deletedAt: null },
    })
    return space ? mapSpace(space) : null
  },
})

export const buildNativeSourceRef = (pageId: string, versionId: string | null): string =>
  versionId ? `kb://first-party/pages/${pageId}/versions/${versionId}` : `kb://first-party/pages/${pageId}`

export const buildSpaceSourceRef = (spaceId: string): string =>
  `kb://first-party/spaces/${spaceId}`
