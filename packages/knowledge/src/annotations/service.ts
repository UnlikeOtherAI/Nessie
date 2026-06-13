import { Prisma, type PrismaClient } from '@prisma/client'
import { canReadSpace, canWriteSpace } from '../access.js'
import { KnowledgeAnnotationError } from '../errors.js'
import { annotationInclude, mapAnnotation } from './mappers.js'
import type {
  AnnotationAccess,
  AnnotationActor,
  AnnotationRecord,
  TextQuoteAnchor,
} from './types.js'

type Db = PrismaClient | Prisma.TransactionClient

export type AnnotationServiceDeps = { prisma: Db }

const MAX_BODY = 10_000

const requireRead = (access: AnnotationAccess): void => {
  if (!canReadSpace(access.space, access.viewer)) {
    throw new KnowledgeAnnotationError('forbidden', 'No read access to this page')
  }
}

const requireWrite = (access: AnnotationAccess): void => {
  if (!canWriteSpace(access.space, access.viewer)) {
    throw new KnowledgeAnnotationError('forbidden', 'No write access to this page')
  }
}

const cleanBody = (body: string): string => {
  const trimmed = body.trim()
  if (!trimmed) throw new KnowledgeAnnotationError('invalid', 'Body must not be empty')
  if (trimmed.length > MAX_BODY) {
    throw new KnowledgeAnnotationError('invalid', `Body exceeds ${MAX_BODY} characters`)
  }
  return trimmed
}

type OwnableRow = {
  authorType: string
  authorId: string
  delegatedByAgentId: string | null
}

const ownsAnnotation = (row: OwnableRow, actor: AnnotationActor): boolean => {
  if (row.authorType === actor.authorType && row.authorId === actor.authorId) return true
  return Boolean(
    actor.delegatedByAgentId &&
      row.delegatedByAgentId &&
      actor.delegatedByAgentId === row.delegatedByAgentId,
  )
}

const authorFields = (actor: AnnotationActor) => ({
  authorType: actor.authorType,
  authorId: actor.authorId,
  delegatedByAgentId: actor.delegatedByAgentId ?? null,
})

// Single source of access-checked comment/note logic, shared by the API routes
// and the worker agent tools so enforcement can never drift between them.
export const createAnnotationService = ({ prisma }: AnnotationServiceDeps) => {
  const loadOnPage = async (access: AnnotationAccess, annotationId: string) => {
    const row = await prisma.knowledgePageAnnotation.findFirst({
      where: {
        id: annotationId,
        pageId: access.pageId,
        organizationId: access.organizationId,
        deletedAt: null,
      },
    })
    if (!row) throw new KnowledgeAnnotationError('not_found', 'Annotation not found')
    return row
  }

  const reload = async (annotationId: string): Promise<AnnotationRecord> => {
    const row = await prisma.knowledgePageAnnotation.findUniqueOrThrow({
      where: { id: annotationId },
      include: annotationInclude,
    })
    return mapAnnotation(row)
  }

  return {
    async listForPage(
      access: AnnotationAccess,
      opts?: { kind?: 'comment' | 'note' },
    ): Promise<AnnotationRecord[]> {
      requireRead(access)
      const rows = await prisma.knowledgePageAnnotation.findMany({
        where: {
          pageId: access.pageId,
          organizationId: access.organizationId,
          parentId: null,
          deletedAt: null,
          ...(opts?.kind ? { kind: opts.kind } : {}),
        },
        include: annotationInclude,
        orderBy: { createdAt: 'desc' },
      })
      return rows.map(mapAnnotation)
    },

    async createComment(
      access: AnnotationAccess,
      input: { body: string; actor: AnnotationActor },
    ): Promise<AnnotationRecord> {
      requireRead(access)
      const row = await prisma.knowledgePageAnnotation.create({
        data: {
          pageId: access.pageId,
          spaceId: access.spaceId,
          organizationId: access.organizationId,
          kind: 'comment',
          body: cleanBody(input.body),
          ...authorFields(input.actor),
        },
        include: annotationInclude,
      })
      return mapAnnotation(row)
    },

    async createNote(
      access: AnnotationAccess,
      input: {
        body: string
        anchor: TextQuoteAnchor
        anchorVersionId?: string | null
        actor: AnnotationActor
      },
    ): Promise<AnnotationRecord> {
      requireRead(access)
      const row = await prisma.knowledgePageAnnotation.create({
        data: {
          pageId: access.pageId,
          spaceId: access.spaceId,
          organizationId: access.organizationId,
          kind: 'note',
          body: cleanBody(input.body),
          anchor: input.anchor as unknown as Prisma.InputJsonValue,
          anchorVersionId: input.anchorVersionId ?? null,
          ...authorFields(input.actor),
        },
        include: annotationInclude,
      })
      return mapAnnotation(row)
    },

    async reply(
      access: AnnotationAccess,
      input: { parentId: string; body: string; actor: AnnotationActor },
    ): Promise<AnnotationRecord> {
      requireRead(access)
      const parent = await loadOnPage(access, input.parentId)
      if (parent.parentId) {
        throw new KnowledgeAnnotationError('invalid', 'Replies are one level deep')
      }
      const row = await prisma.knowledgePageAnnotation.create({
        data: {
          pageId: access.pageId,
          spaceId: access.spaceId,
          organizationId: access.organizationId,
          kind: parent.kind,
          parentId: parent.id,
          body: cleanBody(input.body),
          ...authorFields(input.actor),
        },
      })
      return mapAnnotation(row)
    },

    async setState(
      access: AnnotationAccess,
      input: { annotationId: string; state: 'open' | 'resolved'; actor: AnnotationActor },
    ): Promise<AnnotationRecord> {
      requireWrite(access)
      const row = await loadOnPage(access, input.annotationId)
      const resolving = input.state === 'resolved'
      await prisma.knowledgePageAnnotation.update({
        where: { id: row.id },
        data: {
          state: input.state,
          resolvedAt: resolving ? new Date() : null,
          resolvedByType: resolving ? input.actor.authorType : null,
          resolvedById: resolving ? input.actor.authorId : null,
        },
      })
      return reload(row.id)
    },

    async edit(
      access: AnnotationAccess,
      input: { annotationId: string; body: string; actor: AnnotationActor },
    ): Promise<AnnotationRecord> {
      requireRead(access)
      const row = await loadOnPage(access, input.annotationId)
      if (!ownsAnnotation(row, input.actor)) {
        throw new KnowledgeAnnotationError('forbidden', 'Only the author can edit this')
      }
      await prisma.knowledgePageAnnotation.update({
        where: { id: row.id },
        data: { body: cleanBody(input.body), editedAt: new Date() },
      })
      return reload(row.id)
    },

    async remove(
      access: AnnotationAccess,
      input: { annotationId: string; actor: AnnotationActor },
    ): Promise<void> {
      requireRead(access)
      const row = await loadOnPage(access, input.annotationId)
      if (!ownsAnnotation(row, input.actor)) {
        throw new KnowledgeAnnotationError('forbidden', 'Only the author can delete this')
      }
      const now = new Date()
      await prisma.knowledgePageAnnotation.updateMany({
        where: {
          OR: [{ id: row.id }, { parentId: row.id }],
          deletedAt: null,
        },
        data: { deletedAt: now },
      })
    },

    // Toggle one emoji reaction by the actor on an annotation (add if absent,
    // remove if present). Anyone who can read the page may react.
    async toggleReaction(
      access: AnnotationAccess,
      input: { annotationId: string; emoji: string; actor: AnnotationActor },
    ): Promise<AnnotationRecord> {
      requireRead(access)
      const emoji = input.emoji.trim()
      if (!emoji) throw new KnowledgeAnnotationError('invalid', 'emoji is required')
      const row = await loadOnPage(access, input.annotationId)
      const isAgent = input.actor.authorType === 'agent'
      const where = isAgent
        ? {
            annotationId_agentId_emoji: {
              annotationId: row.id,
              agentId: input.actor.authorId,
              emoji,
            },
          }
        : {
            annotationId_userId_emoji: {
              annotationId: row.id,
              userId: input.actor.authorId,
              emoji,
            },
          }
      const existing = await prisma.knowledgePageAnnotationReaction.findUnique({ where })
      if (existing) {
        await prisma.knowledgePageAnnotationReaction.delete({ where })
      } else {
        await prisma.knowledgePageAnnotationReaction.create({
          data: {
            annotationId: row.id,
            organizationId: access.organizationId,
            emoji,
            ...(isAgent ? { agentId: input.actor.authorId } : { userId: input.actor.authorId }),
          },
        })
      }
      return reload(row.id)
    },
  }
}

export type AnnotationService = ReturnType<typeof createAnnotationService>

// Resolve which page (and space) an annotation belongs to, org-scoped. Callers
// use this to load the page's space and build AnnotationAccess for the
// annotation-id routes/tools (reply, resolve, edit, delete). Returns null when
// the annotation does not exist in the org or is deleted.
export const findAnnotationLocation = async (
  prisma: Db,
  organizationId: string,
  annotationId: string,
): Promise<{ pageId: string; spaceId: string } | null> => {
  const row = await prisma.knowledgePageAnnotation.findFirst({
    where: { id: annotationId, organizationId, deletedAt: null },
    select: { pageId: true, spaceId: true },
  })
  return row
}
