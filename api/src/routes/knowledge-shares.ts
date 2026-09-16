import type { FastifyInstance, FastifyReply } from 'fastify'
import {
  canReadSpace,
  listPageShares,
  mapPage,
  pageInclude,
  removePageShare,
  setPageShareAccess,
  sharedSubtreePageIds,
  upsertPageShare,
  viewerHoldsPageShare,
  type KnowledgePageRecord,
  type KnowledgePageShareRow,
  type KnowledgeProvider,
  type SpaceViewer,
} from '@nessie/knowledge'
import { resolveDisclosureViewer } from '@nessie/runtime'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import {
  CreateKnowledgePageShareBodySchema,
  KnowledgePageShareRecordSchema,
  UpdateKnowledgePageShareBodySchema,
} from '@nessie/schemas'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import {
  canManageKnowledgeSpaceAccess,
  createKnowledgeAccess,
  requireKnowledgePolicy,
  requestIds,
  type KnowledgeRouteDeps,
} from './knowledge-base-access.js'

/**
 * Person-to-person sharing of a page the sharer owns.
 *
 * Two rules the handlers keep, recorded here because they are what the routes
 * exist to enforce rather than details of any one of them:
 *
 * 1. **No approval gate.** The agent publication approval
 *    (`knowledge.page.publish`) exists because agents draft and a person
 *    publishes. A person sharing their own document with another person is a
 *    different act: the row is written on the request and takes effect on the
 *    next read. It never creates an `Approval` row, never routes through
 *    `approval-effects.ts` and never appears under "Needs review".
 * 2. **Only the sharer reads the list.** A grantee asking who else a page is
 *    shared with gets the same 403 as a stranger, so the list never discloses
 *    the other recipients.
 *
 * 3. **The recipient is told once, durably.** A grant is silent otherwise: a
 *    row appears in Shared with me and nothing points at it. The
 *    `knowledge_shared` bell row is that pointer — the reader side of the enum
 *    shipped one deploy before this writer, so a replica running the previous
 *    build never receives a kind it cannot parse
 *    (`nessie-new-realtime-kind-must-be-inert`). It is a durable row only, not
 *    a push: a push carrying a private document's title needs its own
 *    preference kind and its own delivery-time revalidation, which is not this
 *    change.
 *
 * Contract: docs/plans/2026-09-16-documents-finder-ui/data-and-api.md §2.
 */

const shareRecord = (share: KnowledgePageShareRow) =>
  KnowledgePageShareRecordSchema.parse({
    id: share.id,
    pageId: share.pageId,
    granteeUserId: share.granteeUserId,
    grantedByUserId: share.grantedByUserId,
    access: share.access,
    createdAt: share.createdAt,
    updatedAt: share.updatedAt,
  })

/**
 * `GET /spaces/:spaceId/pages?sharedRootPageId=` — a shared folder's children
 * for the person it was shared with, although the space itself is private to
 * the sharer.
 *
 * Returns null when the ordinary space arm should answer: either the viewer can
 * read the space anyway, or the share does not hold and the 403 stands.
 */
export const listSharedRootSubtree = async (
  prisma: PrismaClient,
  provider: KnowledgeProvider,
  input: {
    actorContext: AuthorizedActionContext
    viewer: SpaceViewer
    spaceId: string
    rootPageId: string
  },
): Promise<{ pages: KnowledgePageRecord[]; truncated: boolean } | null> => {
  const { organizationId } = input.actorContext.tenant
  const space = await provider.getSpace(organizationId, input.spaceId)
  if (!space) return null
  if (canReadSpace(space, input.viewer)) return null
  const root = await provider.getPage(organizationId, input.rootPageId)
  if (!root || root.spaceId !== input.spaceId) return null
  const holds = await viewerHoldsPageShare(prisma, {
    organizationId,
    actorType: input.actorContext.actor.actorType,
    page: root,
    viewer: input.viewer,
    minimum: 'view',
  })
  if (!holds) return null
  const { pageIds, truncated } = await sharedSubtreePageIds(prisma, {
    organizationId,
    rootPageId: input.rootPageId,
  })
  const rows = await prisma.knowledgePage.findMany({
    where: { id: { in: pageIds }, organizationId, deletedAt: null, status: { not: 'archived' } },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    include: pageInclude,
  })
  return { pages: rows.map(mapPage), truncated }
}

/** The `?sharedRootPageId=` query value, or null when absent or not a uuid. */
export const readSharedRootPageId = (query: unknown): string | null => {
  const value = (query as { sharedRootPageId?: unknown } | null)?.sharedRootPageId
  if (typeof value !== 'string') return null
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null
}


/**
 * The recipient's bell row for a document somebody just handed them.
 *
 * Keyed on the share rather than on the moment, so re-granting after a revoke
 * writes one row and a retried request writes none. It is deliberately *not*
 * an approval and not a review queue item: nothing here waits for anybody, and
 * the row is a doorway to a document the person already has.
 *
 * A failure to write it must never fail the share: the grant is the act, and
 * the bell is how the recipient hears about it.
 */
const writeSharedAlert = async (
  prisma: PrismaClient,
  input: {
    actorUserId: string
    granteeUserId: string
    organizationId: string
    pageId: string
  },
): Promise<void> => {
  try {
    await prisma.userAlert.upsert({
      where: {
        userId_eventKey: {
          eventKey: `knowledge-shared:${input.pageId}:${input.granteeUserId}`,
          userId: input.granteeUserId,
        },
      },
      create: {
        actorUserId: input.actorUserId,
        eventKey: `knowledge-shared:${input.pageId}:${input.granteeUserId}`,
        kind: 'knowledge_shared',
        knowledgePageId: input.pageId,
        organizationId: input.organizationId,
        userId: input.granteeUserId,
      },
      update: {},
      select: { id: true },
    })
  } catch {
    // Swallowed on purpose; see above.
  }
}

export const registerKnowledgeShareRoutes = (
  app: FastifyInstance,
  deps: KnowledgeRouteDeps,
): void => {
  const { prisma, requireActorContext } = deps
  const { provider, buildViewer, canReadPageVersionsWithViewer } = createKnowledgeAccess(deps)
  const resolveViewer = deps.resolveDisclosureViewer ?? resolveDisclosureViewer

  /**
   * Every share route starts here: the page, its space, and the two facts that
   * decide who may act — is this the sharer's own personal documents, and is the
   * caller the sharer (or the organisation's owner)?
   *
   * The personal-space rule is what stops a project member handing a project
   * document to somebody outside the project: a project's audience is its
   * membership, read out rather than granted.
   */
  const loadShareTarget = async (
    actorContext: AuthorizedActionContext,
    pageId: string,
    reply: FastifyReply,
  ): Promise<{
    page: KnowledgePageRecord
    spaceId: string
    viewer: SpaceViewer
    isOwner: boolean
    mayManage: boolean
  } | null> => {
    if (actorContext.actor.actorType !== 'user') {
      sendApiError(reply, 403, 'ACTOR_TYPE_NOT_ALLOWED', 'Only a person can share a document')
      return null
    }
    const { organizationId } = actorContext.tenant
    const page = await provider.getPage(organizationId, pageId)
    if (!page) {
      sendApiError(reply, 404, 'KNOWLEDGE_PAGE_NOT_FOUND', 'Page not found')
      return null
    }
    const space = await provider.getSpace(organizationId, page.spaceId)
    // Personal documents are the only pages a person may hand to another
    // person. Whose personal documents they are decides who may act, below;
    // that a project's or a shared folder's page is not shareable at all is
    // decided here, and is the same answer for everybody.
    const personal = space !== null
      && space.metadata !== null
      && space.metadata.personal === true
    if (!space || !personal) {
      sendApiError(
        reply,
        403,
        'SHARE_NOT_PERSONAL',
        'Only documents in My Documents can be shared with a person',
      )
      return null
    }
    const viewer = await buildViewer(actorContext)
    return {
      page,
      spaceId: space.id,
      viewer,
      isOwner: space.userId === actorContext.actor.actorId,
      // For a personal space this reads exactly "the sharer, or the
      // organisation's owner": the space's creator is the person it belongs to.
      mayManage: canManageKnowledgeSpaceAccess(space, actorContext, viewer),
    }
  }

  app.get('/api/knowledge-base/pages/:pageId/shares', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'read')
    if (!decision) return reply
    const { pageId } = request.params as { pageId: string }
    const target = await loadShareTarget(actorContext, pageId, reply)
    if (!target) return reply
    if (!target.mayManage) {
      sendApiError(
        reply,
        403,
        'POLICY_DENIED',
        'Only the owner of this document can see who it is shared with',
      )
      return reply
    }
    const shares = await listPageShares(prisma, {
      organizationId: actorContext.tenant.organizationId,
      pageId,
    })
    return createApiResponse(shares.map(shareRecord))
  })

  app.post('/api/knowledge-base/pages/:pageId/shares', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const body = parseInput(CreateKnowledgePageShareBodySchema, request.body, reply)
    if (!body) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'edit')
    if (!decision) return reply
    const { pageId } = request.params as { pageId: string }
    const target = await loadShareTarget(actorContext, pageId, reply)
    if (!target) return reply
    // Creating a share is the owner's act alone. Reading the list and changing a
    // level are open to the organisation's owner as well; minting a new audience
    // for somebody else's private document is not.
    if (!target.isOwner) {
      sendApiError(
        reply,
        403,
        'SHARE_NOT_PERSONAL',
        'Only documents in My Documents can be shared with a person',
      )
      return reply
    }
    if (body.granteeUserId === actorContext.actor.actorId) {
      sendApiError(reply, 400, 'SHARE_SELF', 'You already have access to your own document')
      return reply
    }
    if (target.page.status === 'archived' || target.page.deletedAt !== null) {
      sendApiError(reply, 409, 'KNOWLEDGE_MUTATION_CONFLICT', 'This document has been deleted')
      return reply
    }
    const { organizationId } = actorContext.tenant
    const membership = await prisma.organizationMember.findFirst({
      where: { organizationId, userId: body.granteeUserId, deactivatedAt: null },
      select: { user: { select: { displayName: true } } },
    })
    if (!membership) {
      sendApiError(reply, 404, 'USER_NOT_FOUND', 'That person is not a member of this organisation')
      return reply
    }
    // The grantee must be able to read every retained version's basis, not only
    // the current one: history is part of what a share opens, and a version the
    // recipient could not be shown would otherwise sit behind a grant that looks
    // complete (docs/standards/disclosure-boundaries.md).
    const granteeDisclosure = await resolveViewer(prisma, organizationId, body.granteeUserId, {
      allowStoredUoaIdentity: true,
    })
    if (!(await canReadPageVersionsWithViewer(target.page, granteeDisclosure))) {
      sendApiError(
        reply,
        403,
        'SHARE_SOURCE_RESTRICTED',
        `This document contains material ${membership.user.displayName} cannot be shown`,
      )
      return reply
    }
    const access = body.access ?? 'view'
    const result = await upsertPageShare(prisma, {
      organizationId,
      pageId,
      spaceId: target.spaceId,
      granteeUserId: body.granteeUserId,
      grantedByUserId: actorContext.actor.actorId,
      access,
    })
    if (result.created) {
      await emitAuditEvent(prisma, {
        actorContext,
        action: 'kb.page.shared',
        resourceType: 'knowledge_page',
        resourceId: pageId,
        outcome: 'success',
        metadata: { granteeUserId: body.granteeUserId, access, spaceId: target.spaceId },
        ...requestIds(request),
      })
    } else if (result.previousAccess !== null && result.previousAccess !== access) {
      await emitAuditEvent(prisma, {
        actorContext,
        action: 'kb.page.share_changed',
        resourceType: 'knowledge_page',
        resourceId: pageId,
        outcome: 'success',
        metadata: {
          granteeUserId: body.granteeUserId,
          from: result.previousAccess,
          to: access,
          spaceId: target.spaceId,
        },
        ...requestIds(request),
      })
    }
    if (result.created) {
      await writeSharedAlert(prisma, {
        actorUserId: actorContext.actor.actorId,
        granteeUserId: body.granteeUserId,
        organizationId,
        pageId,
      })
    }
    const payload = createApiResponse(shareRecord(result.share))
    return result.created ? reply.code(201).send(payload) : payload
  })

  app.patch('/api/knowledge-base/pages/:pageId/shares/:granteeUserId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const body = parseInput(UpdateKnowledgePageShareBodySchema, request.body, reply)
    if (!body) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'edit')
    if (!decision) return reply
    const { pageId, granteeUserId } = request.params as { pageId: string; granteeUserId: string }
    const target = await loadShareTarget(actorContext, pageId, reply)
    if (!target) return reply
    if (!target.mayManage) {
      sendApiError(
        reply,
        403,
        'POLICY_DENIED',
        'Only the owner of this document can change who has access',
      )
      return reply
    }
    const result = await setPageShareAccess(prisma, {
      organizationId: actorContext.tenant.organizationId,
      pageId,
      granteeUserId,
      access: body.access,
    })
    if (!result) {
      sendApiError(
        reply,
        404,
        'KNOWLEDGE_PAGE_SHARE_NOT_FOUND',
        'This document is not shared with that person',
      )
      return reply
    }
    if (result.previousAccess !== body.access) {
      await emitAuditEvent(prisma, {
        actorContext,
        action: 'kb.page.share_changed',
        resourceType: 'knowledge_page',
        resourceId: pageId,
        outcome: 'success',
        metadata: {
          granteeUserId,
          from: result.previousAccess,
          to: body.access,
          spaceId: target.spaceId,
        },
        ...requestIds(request),
      })
    }
    return createApiResponse(shareRecord(result.share))
  })

  app.delete('/api/knowledge-base/pages/:pageId/shares/:granteeUserId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'edit')
    if (!decision) return reply
    const { pageId, granteeUserId } = request.params as { pageId: string; granteeUserId: string }
    if (actorContext.actor.actorType !== 'user') {
      sendApiError(reply, 403, 'ACTOR_TYPE_NOT_ALLOWED', 'Only a person can change a share')
      return reply
    }
    const { organizationId } = actorContext.tenant
    // A grantee declining a share ("Remove from Shared with me") is not an act
    // in the owner's space, so it resolves before the personal-space check that
    // would refuse them.
    const leaving = granteeUserId === actorContext.actor.actorId
    let spaceId: string | null = null
    if (!leaving) {
      const target = await loadShareTarget(actorContext, pageId, reply)
      if (!target) return reply
      if (!target.mayManage) {
        sendApiError(
          reply,
          403,
          'POLICY_DENIED',
          'Only the owner of this document can change who has access',
        )
        return reply
      }
      spaceId = target.spaceId
    }
    const removed = await removePageShare(prisma, { organizationId, pageId, granteeUserId })
    if (!removed) {
      sendApiError(
        reply,
        404,
        'KNOWLEDGE_PAGE_SHARE_NOT_FOUND',
        'This document is not shared with that person',
      )
      return reply
    }
    await emitAuditEvent(prisma, {
      actorContext,
      action: 'kb.page.unshared',
      resourceType: 'knowledge_page',
      resourceId: pageId,
      outcome: 'success',
      metadata: {
        granteeUserId,
        spaceId: spaceId ?? removed.spaceId,
        by: leaving ? 'grantee' : 'sharer',
      },
      ...requestIds(request),
    })
    return reply.code(204).send()
  })
}
