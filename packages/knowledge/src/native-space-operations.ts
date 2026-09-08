import { Prisma, type PrismaClient } from '@prisma/client'
import { KnowledgeConflictError } from './errors.js'
import { readableKnowledgeSpaceWhere } from './access.js'
import { mapPage, mapSpace, spaceInclude } from './native-mappers.js'
import {
  fetchPage,
  indexVersionChunks,
  markdownProjectionForAttachment,
  type NativeKnowledgeProviderOptions,
} from './native-version-writer.js'
import { clampLimit, parseCursor, trimPage } from './pagination.js'
import type {
  CreatePageInput,
  CreateSpaceInput,
  KnowledgeSpaceRecord,
  ListSpacesInput,
  UpdateSpaceInput,
} from './types.js'
import { replaceLabels } from './native-labels.js'
import { resolveLinksToPage } from './native-links.js'

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

const assertUsersBelongToOrg = async (
  client: PrismaClient | Prisma.TransactionClient,
  organizationId: string,
  userIds: string[],
): Promise<void> => {
  const found = await client.organizationMember.findMany({
    where: {
      organizationId,
      userId: { in: userIds },
      deactivatedAt: null,
    },
    select: { userId: true },
  })
  const foundIds = new Set(found.map((member) => member.userId))
  const unknown = userIds.filter((id) => !foundIds.has(id))
  if (unknown.length > 0) {
    throw new KnowledgeConflictError(
      `Unknown, foreign, or deactivated user id(s) for knowledge space membership: ${unknown.join(', ')}`,
    )
  }
}

const assertProjectBelongsToOrg = async (
  client: PrismaClient | Prisma.TransactionClient,
  organizationId: string,
  projectId: string,
): Promise<void> => {
  const project = await client.project.findFirst({
    where: { id: projectId, organizationId },
    select: { id: true },
  })
  if (!project) {
    throw new KnowledgeConflictError('Knowledge space project does not belong to this organization')
  }
}

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

export const archiveSpace = async (
  prisma: PrismaClient,
  organizationId: string,
  spaceId: string,
): Promise<KnowledgeSpaceRecord | null> => {
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
}

export const createPage = async (
  prisma: PrismaClient,
  options: NativeKnowledgeProviderOptions,
  input: CreatePageInput,
): Promise<ReturnType<typeof mapPage>> => {
  const projection = input.attachmentId
    ? await markdownProjectionForAttachment(prisma, options, input.organizationId, input.attachmentId)
    : null
  if (projection && (input.body !== undefined || input.bodyRef !== undefined)) {
    throw new KnowledgeConflictError('Markdown attachment versions cannot supply an independent body')
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
          id: input.parentPageId,
          organizationId: input.organizationId,
          spaceId: input.spaceId,
          deletedAt: null,
          status: { not: 'archived' },
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
      },
    })
    await indexVersionChunks(tx, options, page, version)
    await replaceLabels(tx, { labels: input.labels, organizationId: input.organizationId, pageId: page.id })
    const created = await fetchPage(tx, input.organizationId, page.id)
    if (!created) throw new Error('Created page could not be loaded')
    return created
  })
}

export const createSpace = async (
  prisma: PrismaClient,
  input: CreateSpaceInput,
): Promise<KnowledgeSpaceRecord> => {
  const memberUserIds = Array.from(new Set(input.memberUserIds ?? []))
  const memberAgentIds = Array.from(new Set(input.memberAgentIds ?? []))
  await assertProjectBelongsToOrg(prisma, input.organizationId, input.projectId)
  if (memberUserIds.length > 0) await assertUsersBelongToOrg(prisma, input.organizationId, memberUserIds)
  if (memberAgentIds.length > 0) await assertAgentsBelongToOrg(prisma, input.organizationId, memberAgentIds)
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
              ...memberUserIds.map((userId) => ({ userId, organizationId: input.organizationId })),
              ...memberAgentIds.map((agentId) => ({ agentId, organizationId: input.organizationId })),
            ],
          }
        : undefined,
    },
    include: spaceInclude,
  })
  return mapSpace(space)
}

export const getSpace = async (
  prisma: PrismaClient,
  organizationId: string,
  spaceId: string,
): Promise<KnowledgeSpaceRecord | null> => {
  const space = await prisma.knowledgeSpace.findFirst({
    where: { id: spaceId, organizationId, deletedAt: null },
    include: spaceInclude,
  })
  return space ? mapSpace(space) : null
}

export const listSpaces = async (
  prisma: PrismaClient,
  input: ListSpacesInput,
) => {
  const limit = clampLimit(input.limit)
  const cursor = parseCursor(input.cursor)
  const backwards = input.direction === 'backward'
  const readableWhere = input.viewer
    ? readableKnowledgeSpaceWhere(input.organizationId, input.viewer)
    : null
  const scopeFilters: Prisma.KnowledgeSpaceWhereInput[] = [
    ...(input.projectId ? [{ projectId: input.projectId }] : []),
    ...(!input.includePersonal && typeof input.viewer?.userId === 'string'
      ? [{ OR: [{ userId: null }, { userId: { not: input.viewer.userId } }] }]
      : []),
  ]
  const where: Prisma.KnowledgeSpaceWhereInput = {
    AND: [
      readableWhere ?? { organizationId: input.organizationId, deletedAt: null },
      ...scopeFilters,
      ...(cursor
        ? [{
            OR: [
              { updatedAt: { [backwards ? 'gt' : 'lt']: cursor.cursorDate } },
              { updatedAt: cursor.cursorDate, id: { [backwards ? 'gt' : 'lt']: cursor.cursorId } },
            ],
          }]
        : []),
    ],
  }
  const countWhere: Prisma.KnowledgeSpaceWhereInput = {
    AND: [readableWhere ?? { organizationId: input.organizationId, deletedAt: null }, ...scopeFilters],
  }
  const [spaces, total] = await Promise.all([
    prisma.knowledgeSpace.findMany({
      where,
      orderBy: backwards
        ? [{ updatedAt: 'asc' }, { id: 'asc' }]
        : [{ updatedAt: 'desc' }, { id: 'desc' }],
      include: spaceInclude,
      take: limit + 1,
    }),
    prisma.knowledgeSpace.count({ where: countWhere }),
  ])
  const page = trimPage(spaces.map(mapSpace), limit, {
    cursor: cursor ? input.cursor : undefined,
    direction: input.direction,
    hasCursor: Boolean(cursor),
  })
  return { ...page, meta: { ...page.meta, total } }
}

export const updateSpace = async (
  prisma: PrismaClient,
  organizationId: string,
  spaceId: string,
  input: UpdateSpaceInput,
): Promise<KnowledgeSpaceRecord | null> => {
  const space = await prisma.$transaction(async (tx) => {
    const existing = await tx.knowledgeSpace.findFirst({
      where: { id: spaceId, organizationId, deletedAt: null },
      select: { id: true },
    })
    if (!existing) return null
    const data = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
      ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      ...(input.writeRestricted !== undefined ? { writeRestricted: input.writeRestricted } : {}),
      ...(input.sensitivityTier !== undefined ? { sensitivityTier: input.sensitivityTier } : {}),
    }
    if (Object.keys(data).length > 0) await tx.knowledgeSpace.update({ where: { id: spaceId }, data })
    if (input.memberAgentIds !== undefined) {
      const memberAgentIds = Array.from(new Set(input.memberAgentIds))
      if (memberAgentIds.length > 0) await assertAgentsBelongToOrg(tx, organizationId, memberAgentIds)
      await tx.knowledgeSpaceMember.deleteMany({ where: { spaceId, agentId: { not: null } } })
      if (memberAgentIds.length) {
        await tx.knowledgeSpaceMember.createMany({
          data: memberAgentIds.map((agentId) => ({ spaceId, agentId, organizationId })),
        })
      }
    }
    if (input.memberUserIds !== undefined) {
      const memberUserIds = Array.from(new Set(input.memberUserIds))
      if (memberUserIds.length > 0) await assertUsersBelongToOrg(tx, organizationId, memberUserIds)
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
}
