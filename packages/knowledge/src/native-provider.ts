import { Prisma, type PrismaClient } from '@prisma/client'
import { KnowledgeConflictError } from './errors.js'
import { replaceLabels } from './native-labels.js'
import { canReadSpace } from './access.js'
import { mapPage, mapSpace, mapVersion, pageInclude, spaceInclude } from './native-mappers.js'
import { searchNativePages } from './native-search.js'
import { searchNativePagesHybrid } from './native-search-hybrid.js'
import { replaceKnowledgePageVersionChunks, type ChunkablePage } from './native-chunks.js'
import { clampLimit, parseCursor, trimPage } from './pagination.js'
import type {
  AddFileVersionInput,
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

export type KnowledgeVersionIndexedEvent = {
  organizationId: string
  pageId: string
  versionId: string
}

export type NativeKnowledgeProviderOptions = {
  // Invoked inside the same transaction that wrote a version's chunk rows —
  // the api wires this to enqueue the `knowledge.embed` job, so a failed
  // enqueue rolls the save back instead of silently losing the embedding pass.
  onVersionChunksReplaced?: (
    tx: Prisma.TransactionClient,
    event: KnowledgeVersionIndexedEvent,
  ) => Promise<void>
}

const nativeCapabilities = {
  canWrite: true,
  canIncrementalSync: false,
  supportsNativeSearch: true,
  supportsServerSideACL: true,
  supportsVersionHistory: true,
  supportsHierarchicalPages: true,
  supportsDeterministicSearch: true,
} as const

const VERSION_CREATE_MAX_ATTEMPTS = 3
const ARCHIVED_PAGE_MESSAGE = 'Archived pages are read-only'

// Knowledge-space agent membership grants must name real agents in the same
// org — otherwise a grant silently never matches any SpaceViewer.agent.id and
// looks like a bug in access.ts rather than bad input. Reject rather than
// silently drop foreign/unknown ids.
const assertAgentsBelongToOrg = async (
  client: PrismaClient | Prisma.TransactionClient,
  organizationId: string,
  agentIds: string[],
): Promise<void> => {
  const found = await client.agent.findMany({
    where: { id: { in: agentIds }, organizationId },
    select: { id: true },
  })
  const foundIds = new Set(found.map((agent) => agent.id))
  const unknown = agentIds.filter((id) => !foundIds.has(id))
  if (unknown.length > 0) {
    throw new KnowledgeConflictError(
      `Unknown agent id(s) for knowledge space membership: ${unknown.join(', ')}`,
    )
  }
}

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

const isVersionNumberConflict = (error: unknown): boolean => {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== 'P2002'
  ) {
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

const withVersionNumberRetry = async <T>(operation: () => Promise<T>): Promise<T> => {
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

const getMutablePage = async (
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
    },
  })
  if (!page) return null
  if (page.status === 'archived') throw new KnowledgeConflictError(ARCHIVED_PAGE_MESSAGE)
  return page
}

// Chunk a version and fire the index hook when rows were actually written
// (replaceKnowledgePageVersionChunks no-ops on already-chunked versions).
const indexVersionChunks = async (
  tx: Prisma.TransactionClient,
  options: NativeKnowledgeProviderOptions,
  page: ChunkablePage,
  version: { body: string | null; id: string },
): Promise<void> => {
  const written = await replaceKnowledgePageVersionChunks(tx, { page, version })
  if (written && options.onVersionChunksReplaced) {
    await options.onVersionChunksReplaced(tx, {
      organizationId: page.organizationId,
      pageId: page.id,
      versionId: version.id,
    })
  }
}

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
    return {
      ...record,
      // Drop the (potentially large) HTML body from the space-pages list — the
      // tree/column views never render it, and the client otherwise holds every
      // page's full body in memory. It is fetched on demand via GET /pages/:id
      // when a document is opened or edited.
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
    await tx.knowledgePage.update({
      where: { id: input.pageId },
      data: { publishedVersionId: latest.id, status: 'published' },
    })
    return fetchPage(tx, input.organizationId, input.pageId)
  })

const restoreVersion = async (
  prisma: PrismaClient,
  options: NativeKnowledgeProviderOptions,
  input: RestorePageVersionInput,
) =>
  withVersionNumberRetry(() => prisma.$transaction(async (tx) => {
    const page = await getMutablePage(tx, input.organizationId, input.pageId)
    if (!page) return null
    const version = await tx.knowledgePageVersion.findFirst({
      where: {
        id: input.versionId,
        pageId: input.pageId,
      },
    })
    if (!version) return null
    const restored = await tx.knowledgePageVersion.create({
      data: {
        pageId: input.pageId,
        versionNumber: await nextVersionNumber(tx, input.pageId),
        body: version.body,
        bodyRef: version.bodyRef,
        attachmentId: version.attachmentId,
        authorType: input.authorType,
        authorId: input.authorId,
        changeComment: input.changeComment ?? `Restored version ${version.versionNumber}`,
      },
    })
    await indexVersionChunks(tx, options, page, restored)
    await tx.knowledgePage.update({
      where: { id: input.pageId },
      data: { status: 'draft' },
    })
    return fetchPage(tx, input.organizationId, input.pageId)
  }))

// Add a new version to a file node, backed by a freshly stored attachment.
// Mirrors the version-creation path but carries an attachmentId instead of body.
const addFileVersion = async (
  prisma: PrismaClient,
  input: AddFileVersionInput,
): Promise<KnowledgePageVersionRecord | null> =>
  withVersionNumberRetry(() => prisma.$transaction(async (tx) => {
    const page = await getMutablePage(tx, input.organizationId, input.pageId)
    if (!page) return null
    const version = await tx.knowledgePageVersion.create({
      data: {
        pageId: input.pageId,
        versionNumber: await nextVersionNumber(tx, input.pageId),
        body: null,
        attachmentId: input.attachmentId,
        authorType: input.authorType,
        authorId: input.authorId,
        changeComment: input.changeComment ?? null,
      },
    })
    // Touch the page so updatedAt reflects the new version.
    await tx.knowledgePage.update({ where: { id: input.pageId }, data: {} })
    return mapVersion(version)
  }))

const updatePage = async (
  prisma: PrismaClient,
  options: NativeKnowledgeProviderOptions,
  pageId: string,
  input: UpdatePageInput,
) =>
  withVersionNumberRetry(() => prisma.$transaction(async (tx) => {
    const existing = await getMutablePage(tx, input.organizationId, pageId)
    if (!existing) return null
    const createsVersion = input.body !== undefined || input.bodyRef !== undefined
    if (createsVersion) {
      const version = await tx.knowledgePageVersion.create({
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
      await indexVersionChunks(tx, options, existing, version)
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
  }))

export const createNativeKnowledgeProvider = (
  prisma: PrismaClient,
  options: NativeKnowledgeProviderOptions = {},
): KnowledgeProvider => ({
  capabilities: nativeCapabilities,
  id: 'native:first-party',
  kind: 'first_party',

  addFileVersion: (input) => addFileVersion(prisma, input),

  archivePage: (organizationId, pageId) => archivePage(prisma, organizationId, pageId),

  archiveSpace: async (organizationId, spaceId) => {
    const result = await prisma.knowledgeSpace.updateMany({
      where: { id: spaceId, organizationId, deletedAt: null },
      data: { deletedAt: new Date() },
    })
    if (result.count === 0) return null
    const space = await prisma.knowledgeSpace.findFirst({
      where: { id: spaceId, organizationId },
      include: spaceInclude,
    })
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
          createdBy: input.createdBy,
        },
      })
      const version = await tx.knowledgePageVersion.create({
        data: {
          pageId: page.id,
          versionNumber: 1,
          body: input.body ?? null,
          bodyRef: input.bodyRef ?? null,
          attachmentId: input.attachmentId ?? null,
          authorType: input.authorType,
          authorId: input.authorId,
          changeComment: input.changeComment ?? null,
        },
      })
      await indexVersionChunks(tx, options, page, version)
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
    const memberUserIds = Array.from(new Set(input.memberUserIds ?? []))
    const memberAgentIds = Array.from(new Set(input.memberAgentIds ?? []))
    if (memberAgentIds.length > 0) {
      await assertAgentsBelongToOrg(prisma, input.organizationId, memberAgentIds)
    }
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
        writeRestricted: input.writeRestricted ?? false,
        sensitivityTier: input.sensitivityTier ?? 'normal',
        privateToAgentId: input.privateToAgentId ?? null,
        createdBy: input.createdBy,
        members: memberUserIds.length || memberAgentIds.length
          ? {
              create: [
                ...memberUserIds.map((userId) => ({
                  userId,
                  organizationId: input.organizationId,
                })),
                ...memberAgentIds.map((agentId) => ({
                  agentId,
                  organizationId: input.organizationId,
                })),
              ],
            }
          : undefined,
      },
      include: spaceInclude,
    })
    return mapSpace(space)
  },

  getPage: fetchPage.bind(null, prisma),

  getSpace: async (organizationId, spaceId) => {
    const space = await prisma.knowledgeSpace.findFirst({
      where: { id: spaceId, organizationId, deletedAt: null },
      include: spaceInclude,
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
      include: spaceInclude,
      take: limit + 1,
    })
    const records = spaces.map(mapSpace)
    const viewer = input.viewer
    const visible =
      viewer && !viewer.bypass
        ? records.filter((space) => canReadSpace(space, viewer))
        : records
    return trimPage(visible, limit)
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
  publishPage: (input) => publishPage(prisma, options, input),
  restoreVersion: (input) => restoreVersion(prisma, options, input),
  searchPages: (input) => searchNativePages(prisma, input),
  searchPagesHybrid: (input) => searchNativePagesHybrid(prisma, input),
  updatePage: (pageId, input) => updatePage(prisma, options, pageId, input),

  updateSpace: async (organizationId, spaceId, input) => {
    const space = await prisma.$transaction(async (tx) => {
      // Existence is checked separately from the scalar update: a members-only
      // patch has an empty scalar data object, and updateMany with empty data
      // matches nothing — which would wrongly read as "space not found".
      const existing = await tx.knowledgeSpace.findFirst({
        where: { id: spaceId, organizationId, deletedAt: null },
        select: { id: true },
      })
      if (!existing) return null
      const data = {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.metadata !== undefined
          ? { metadata: input.metadata as Prisma.InputJsonValue }
          : {}),
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        ...(input.writeRestricted !== undefined
          ? { writeRestricted: input.writeRestricted }
          : {}),
        ...(input.sensitivityTier !== undefined
          ? { sensitivityTier: input.sensitivityTier }
          : {}),
      }
      if (Object.keys(data).length > 0) {
        await tx.knowledgeSpace.update({ where: { id: spaceId }, data })
      }
      // Each principal kind is replaced independently (only when its field is
      // provided), so patching memberUserIds alone can never wipe out agent
      // members as a side effect, and vice versa — both stay atomic within
      // this transaction relative to the caller's intent.
      if (input.memberAgentIds !== undefined) {
        const memberAgentIds = Array.from(new Set(input.memberAgentIds))
        if (memberAgentIds.length > 0) {
          await assertAgentsBelongToOrg(tx, organizationId, memberAgentIds)
        }
        await tx.knowledgeSpaceMember.deleteMany({ where: { spaceId, agentId: { not: null } } })
        if (memberAgentIds.length) {
          await tx.knowledgeSpaceMember.createMany({
            data: memberAgentIds.map((agentId) => ({ spaceId, agentId, organizationId })),
          })
        }
      }
      if (input.memberUserIds !== undefined) {
        const memberUserIds = Array.from(new Set(input.memberUserIds))
        await tx.knowledgeSpaceMember.deleteMany({ where: { spaceId, userId: { not: null } } })
        if (memberUserIds.length) {
          await tx.knowledgeSpaceMember.createMany({
            data: memberUserIds.map((userId) => ({ spaceId, userId, organizationId })),
          })
        }
      }
      return tx.knowledgeSpace.findFirst({
        where: { id: spaceId, organizationId, deletedAt: null },
        include: spaceInclude,
      })
    })
    return space ? mapSpace(space) : null
  },
})

export const buildNativeSourceRef = (pageId: string, versionId: string | null): string =>
  versionId ? `kb://first-party/pages/${pageId}/versions/${versionId}` : `kb://first-party/pages/${pageId}`

export const buildSpaceSourceRef = (spaceId: string): string =>
  `kb://first-party/spaces/${spaceId}`
