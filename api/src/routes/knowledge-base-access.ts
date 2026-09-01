import type { FastifyReply, FastifyRequest } from 'fastify'
import {
  buildNativeSourceRef,
  buildSpaceSourceRef,
  canReadSpace,
  canWriteSpace,
  createNativeKnowledgeProvider,
  loadSpaceViewer,
  type KnowledgePageRecord,
  type KnowledgeProvider,
  type KnowledgeSpaceRecord,
  type SpaceViewer,
  type SpaceViewerPrincipal,
} from '@nessie/knowledge'
import { KNOWLEDGE_EMBED_TOPIC, KnowledgeSpaceResponseSchema } from '@nessie/schemas'
import type {
  AuthorizedActionContext,
  KnowledgeSpaceResponse,
  PaginationMeta,
  PolicyAction,
  PolicyDecision,
  PolicyResourceType,
} from '@nessie/schemas'
import { sendApiError } from '../lib/api.js'
import { enqueueQueueJob } from '../queue/pgqueue.js'
import { createKnowledgePublicationAttention } from '../services/push-attention.js'
import {
  enterKnowledgeInferenceActorContext,
  requireApiKnowledgeInferenceOrigin,
} from '../services/knowledge-inference-origin.js'
import { checkPolicy } from '../services/policy.js'
import type { RouteDeps } from './types.js'

// Shared knowledge-base access/envelope helpers used by both the page routes
// (knowledge-base.ts) and the annotation routes (knowledge-comments.ts), so the
// two-layer access model (coarse policy gate + per-space canRead/canWrite) and
// the response envelope stay identical across them.
export type KnowledgeRouteDeps = RouteDeps & {
  knowledgeProvider?: KnowledgeProvider
}

export const policyTrace = (decision: PolicyDecision): string[] => [
  `decision:${decision.reasonCode}`,
  `source:${decision.policySource}`,
  ...(decision.policyRuleId ? [`rule:${decision.policyRuleId}`] : []),
]

export const visibilityReason = (
  record: { sensitivityTier?: string; visibility?: string },
  decision: PolicyDecision,
): string =>
  `${record.visibility ?? 'unknown'} visibility, ${record.sensitivityTier ?? 'normal'} sensitivity, ${decision.reasonCode}`

const pageVersionRef = (page: KnowledgePageRecord): string | null =>
  page.publishedVersion?.id ?? page.latestVersion?.id ?? page.publishedVersionId

export const canManageKnowledgeSpaceAccess = (
  space: Pick<KnowledgeSpaceRecord, 'createdBy'>,
  actorContext: AuthorizedActionContext,
): boolean =>
  actorContext.actor.actorType === 'service'
  || actorContext.actor.roles?.includes('owner') === true
  || actorContext.actor.actorId === space.createdBy

export const attachSpaceEnvelope = (
  space: KnowledgeSpaceRecord,
  decision: PolicyDecision,
  viewer: SpaceViewer,
  actorContext: AuthorizedActionContext,
): KnowledgeSpaceResponse => KnowledgeSpaceResponseSchema.parse({
  ...space,
  // ownerAgentId is landing in the domain record + native mapper on the
  // sibling implementation branch. Keep the API contract exact in this
  // independently buildable branch; the value becomes live automatically
  // when that mapper supplies it.
  ownerAgentId:
    'ownerAgentId' in space && typeof space.ownerAgentId === 'string'
      ? space.ownerAgentId
      : null,
  canWrite: canWriteSpace(space, viewer),
  canManageAccess: canManageKnowledgeSpaceAccess(space, actorContext),
  policyChainTrace: policyTrace(decision),
  sourceRef: buildSpaceSourceRef(space.id),
  visibilityReason: visibilityReason(space, decision),
})

export type PageEnvelope = KnowledgePageRecord & {
  policyChainTrace: string[]
  sourceRef: string
  visibilityReason: string
}

export const attachPageEnvelope = (
  page: KnowledgePageRecord,
  decision: PolicyDecision,
): PageEnvelope => ({
  ...page,
  policyChainTrace: policyTrace(decision),
  sourceRef: buildNativeSourceRef(page.id, pageVersionRef(page)),
  visibilityReason: visibilityReason(page, decision),
})

export const requireKnowledgePolicy = async (
  deps: RouteDeps,
  actorContext: AuthorizedActionContext,
  reply: FastifyReply,
  resourceType: PolicyResourceType,
  action: PolicyAction,
): Promise<PolicyDecision | null> => {
  const decision = await checkPolicy(deps.prisma, actorContext, resourceType, action)
  if (!decision.allowed) {
    sendApiError(reply, 403, 'POLICY_DENIED', `Knowledge base access denied: ${decision.reasonCode}`)
    return null
  }
  return decision
}

export const requireProjectId = (
  actorContext: AuthorizedActionContext,
  bodyProjectId: string | undefined,
  reply: FastifyReply,
): string | null => {
  const projectId = bodyProjectId ?? actorContext.tenant.projectId
  if (!projectId) {
    sendApiError(reply, 400, 'PROJECT_REQUIRED', 'Knowledge base actions require a projectId')
    return null
  }
  return projectId
}

export const actorAuthorType = (actorContext: AuthorizedActionContext): 'user' | 'agent' =>
  actorContext.actor.actorType === 'agent' ? 'agent' : 'user'

export const requestIds = (request: FastifyRequest) => ({
  ipAddress: request.ip,
  userAgent: request.headers['user-agent'],
})

// `@nessie/knowledge`'s native provider (packages/, out of this route
// family's reach) still returns its own pre-existing `{ cursor, hasMore }`
// cursor-page shape (`KnowledgePageCursorPage`) — that package's contract,
// untouched here. This adapts one of its pages onto the shared
// `PaginationMeta` contract at the API boundary: `nextCursor` carries the
// provider's own opaque cursor forward unchanged, and `prevCursor` is
// re-encoded from the first row of this page in that same `updatedAt|id`
// format, present only once the caller has moved past the first page —
// mirroring how `buildPage` derives `prevCursor`, without forking the
// provider's own cursor encoding.
export const toKnowledgePaginationMeta = (
  providerMeta: { cursor: string | null; hasMore: boolean },
  hasCursor: boolean,
  first: { id: string; updatedAt: string } | undefined,
): PaginationMeta => ({
  hasMore: providerMeta.hasMore,
  nextCursor: providerMeta.cursor,
  prevCursor: hasCursor && first ? `${first.updatedAt}|${first.id}` : null,
})

// Bundles the provider plus the per-space access helpers, closing over the
// route deps once. Both route modules destructure exactly what they need.
export const createKnowledgeAccess = (deps: KnowledgeRouteDeps) => {
  const { prisma } = deps
  const provider = deps.knowledgeProvider ?? createNativeKnowledgeProvider(prisma, {
    // Enqueued inside the save transaction: the job becomes visible only when
    // the version + chunk rows commit, and a failed enqueue rolls the save back.
    onVersionChunksReplaced: async (tx, event) => {
      const origin = await requireApiKnowledgeInferenceOrigin(
        tx,
        event,
        'knowledge-indexer',
      )
      await enqueueQueueJob(tx, {
        idempotencyKey: `kb-embed:${event.pageId}:${event.versionId}`,
        payload: { ...event, origin },
        topic: KNOWLEDGE_EMBED_TOPIC,
      })
    },
    onPagePublished: async (tx, event) => {
      await createKnowledgePublicationAttention(tx, event)
    },
  })

  // 'user' and 'agent' map to their real principal; anything else (including
  // 'service') is a bypass viewer — there is no third first-class principal
  // kind in the knowledge base's access model.
  const buildViewer = (actorContext: AuthorizedActionContext): Promise<SpaceViewer> => {
    // The provider's transactional version hook runs later in the same request
    // chain. Preserve the authenticated team/user here so a project-scoped,
    // teamless space still produces an attributable durable embedding job.
    enterKnowledgeInferenceActorContext(actorContext)
    const { actorType, actorId } = actorContext.actor
    const principal: SpaceViewerPrincipal =
      actorType === 'user' || actorType === 'agent'
        ? { actorType, actorId }
        : { actorType: 'service', actorId }
    return loadSpaceViewer(prisma, actorContext.tenant.organizationId, principal)
  }

  const denyAccess = (reply: FastifyReply, reason: string) =>
    sendApiError(reply, 403, 'POLICY_DENIED', `Knowledge base access denied: ${reason}`)

  // Loads a space and enforces read/write access; sends 404/403 and returns null
  // when the caller may not proceed.
  const accessSpace = async (
    actorContext: AuthorizedActionContext,
    spaceId: string,
    viewer: SpaceViewer,
    mode: 'read' | 'write',
    reply: FastifyReply,
  ): Promise<KnowledgeSpaceRecord | null> => {
    const space = await provider.getSpace(actorContext.tenant.organizationId, spaceId)
    if (!space) {
      sendApiError(reply, 404, 'KNOWLEDGE_SPACE_NOT_FOUND', 'Space not found')
      return null
    }
    if (!(mode === 'read' ? canReadSpace(space, viewer) : canWriteSpace(space, viewer))) {
      denyAccess(reply, mode === 'read' ? 'NOT_A_SPACE_MEMBER' : 'WRITE_NOT_PERMITTED')
      return null
    }
    return space
  }

  // Enforces access on the space a page belongs to.
  const accessPageSpace = async (
    actorContext: AuthorizedActionContext,
    page: KnowledgePageRecord,
    viewer: SpaceViewer,
    mode: 'read' | 'write',
    reply: FastifyReply,
  ): Promise<boolean> =>
    (await accessSpace(actorContext, page.spaceId, viewer, mode, reply)) !== null

  return { provider, buildViewer, denyAccess, accessSpace, accessPageSpace }
}
