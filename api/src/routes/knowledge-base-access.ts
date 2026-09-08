import type { FastifyReply, FastifyRequest } from 'fastify'
import {
  buildNativeSourceRef,
  buildSpaceSourceRef,
  canReadKnowledgePageVersion,
  canReadSpace,
  canWriteSpace,
  createNativeKnowledgeProvider,
  knowledgeEmbeddingJobKey,
  loadSpaceViewer,
  type KnowledgePageRecord,
  type KnowledgeProvider,
  type KnowledgeSpaceRecord,
  type SpaceViewer,
  type SpaceViewerPrincipal,
} from '@nessie/knowledge'
import { resolveDisclosureViewer, resolveLiveEntitlements, type DisclosureViewer } from '@nessie/runtime'
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
import { enqueueQueueJob } from '@nessie/db'
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
  // Tests may supply these exact runtime seams to verify request-local proof
  // reuse without performing a live UOA request.
  resolveDisclosureViewer?: typeof resolveDisclosureViewer
  resolveLiveEntitlements?: typeof resolveLiveEntitlements
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
  viewer: SpaceViewer,
): boolean =>
  actorContext.actor.actorType === 'service'
  || (
    actorContext.actor.actorType === 'user'
    && (
      viewer.organizationRole === 'owner'
      || actorContext.actor.actorId === space.createdBy
    )
  )

// Project membership/binding is the entitlement for creating or provisioning
// project-scoped document resources. A caller's session project is incidental;
// this check uses the viewer assembled for the active organization instead.
export const canViewerReachProject = (viewer: SpaceViewer, projectId: string): boolean =>
  viewer.bypass
  || (viewer.agent ? viewer.agent.projectIds.has(projectId) : viewer.projectIds.has(projectId))

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
  canManageAccess: canManageKnowledgeSpaceAccess(space, actorContext, viewer),
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

// The provider owns both cursor directions. This adapter preserves its opaque
// cursors rather than manufacturing a previous cursor that the provider cannot
// actually fetch backwards.
export const toKnowledgePaginationMeta = (
  providerMeta: {
    cursor: string | null
    hasMore: boolean
    previousCursor?: string | null
    total?: number
  },
): PaginationMeta => ({
  hasMore: providerMeta.hasMore,
  nextCursor: providerMeta.cursor,
  prevCursor: providerMeta.previousCursor ?? null,
  ...(providerMeta.total === undefined ? {} : { total: providerMeta.total }),
})

// Bundles the provider plus the per-space access helpers, closing over the
// route deps once. Both route modules destructure exactly what they need.
export const createKnowledgeAccess = (deps: KnowledgeRouteDeps) => {
  const { prisma } = deps
  const resolveLive = deps.resolveLiveEntitlements ?? resolveLiveEntitlements
  const resolveViewer = deps.resolveDisclosureViewer ?? resolveDisclosureViewer
  const provider = deps.knowledgeProvider ?? createNativeKnowledgeProvider(prisma, {
    readMarkdownAttachment: async (attachmentId, organizationId) => {
      const opened = await deps.fileService.openStream(attachmentId, organizationId)
      return opened?.stream ?? null
    },
    // Enqueued inside the save transaction: the job becomes visible only when
    // the version + chunk rows commit, and a failed enqueue rolls the save back.
    onVersionChunksReplaced: async (tx, event) => {
      const origin = await requireApiKnowledgeInferenceOrigin(
        tx,
        event,
        'knowledge-indexer',
      )
      await enqueueQueueJob(tx, {
        idempotencyKey: knowledgeEmbeddingJobKey(
          event.pageId,
          event.versionId,
          deps.sharedModelClient?.embeddingModel ?? 'unresolved',
        ),
        payload: { ...event, origin },
        topic: KNOWLEDGE_EMBED_TOPIC,
      })
    },
    onPagePublished: async (tx, event) => {
      await createKnowledgePublicationAttention(tx, event)
    },
  })

  // Build the live organization proof once, then reuse it for the document
  // basis and ordinary space entitlement. UOA remains the authority for both.
  const buildViewer = async (actorContext: AuthorizedActionContext): Promise<SpaceViewer> => {
    enterKnowledgeInferenceActorContext(actorContext)
    const { actorType, actorId } = actorContext.actor
    const principal: SpaceViewerPrincipal =
      actorType === 'user' || actorType === 'agent'
        ? { actorType, actorId }
        : { actorType: 'service', actorId }
    if (actorType === 'service') {
      return loadSpaceViewer(prisma, actorContext.tenant.organizationId, principal)
    }
    const userId = actorContext.actionContext.effectiveUserId
      ?? (actorType === 'user' ? actorId : null)
    const liveEntitlements = userId
      ? await resolveLive(prisma, {
          organizationId: actorContext.tenant.organizationId,
          userId,
          uoaIdentity: actorContext.actionContext.uoaIdentity,
        })
      : undefined
    const disclosureViewer = await resolveViewer(
      prisma,
      actorContext.tenant.organizationId,
      userId,
      {
        ...(actorType === 'agent' ? { agentId: actorId } : {}),
        ...(liveEntitlements ? { liveEntitlements } : {
          uoaIdentity: actorContext.actionContext.uoaIdentity,
        }),
      },
    )
    const viewer = await loadSpaceViewer(
      prisma,
      actorContext.tenant.organizationId,
      principal,
      liveEntitlements ? { liveEntitlements, effectiveUserId: userId } : {},
    )
    return { ...viewer, disclosureViewer }
  }

  const denyAccess = (reply: FastifyReply, reason: string) =>
    sendApiError(reply, 403, 'POLICY_DENIED', `Knowledge base access denied: ${reason}`)

  const disclosureViewerFor = (viewer: SpaceViewer): DisclosureViewer | null =>
    viewer.disclosureViewer ?? null

  const canReadVersionWithViewer = (
    version: NonNullable<KnowledgePageRecord['latestVersion']>,
    disclosureViewer: DisclosureViewer | null,
  ): boolean => disclosureViewer === null || canReadKnowledgePageVersion(version, disclosureViewer)

  const canReadVersion = (
    viewer: SpaceViewer,
    version: NonNullable<KnowledgePageRecord['latestVersion']>,
  ): boolean => canReadVersionWithViewer(version, disclosureViewerFor(viewer))

  const canReadPageVersionsWithViewer = async (
    page: KnowledgePageRecord,
    disclosureViewer: DisclosureViewer | null,
  ): Promise<boolean> => {
    const versions = await provider.listVersions(
      page.organizationId,
      page.id,
    )
    return versions.every((version) => canReadVersionWithViewer(version, disclosureViewer))
  }

  const canReadPageVersion = async (
    viewer: SpaceViewer,
    page: KnowledgePageRecord,
  ): Promise<boolean> => canReadPageVersionsWithViewer(page, disclosureViewerFor(viewer))

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
  ): Promise<boolean> => {
    if ((await accessSpace(actorContext, page.spaceId, viewer, mode, reply)) === null) return false

    // Unversioned page metadata and annotations inherit every retained
    // version's source boundary. Letting an editor alter such a page without
    // reading its history would create a disclosure bypass.
    if (await canReadPageVersion(viewer, page)) return true
    denyAccess(reply, 'VERSION_SOURCE_RESTRICTED')
    return false
  }

  const filterReadablePages = async (
    viewer: SpaceViewer,
    pages: readonly KnowledgePageRecord[],
  ): Promise<KnowledgePageRecord[]> => {
    const disclosureViewer = disclosureViewerFor(viewer)
    const readable = await Promise.all(pages.map(async (page) =>
      (await canReadPageVersionsWithViewer(page, disclosureViewer)) ? page : null))
    return readable.filter((page): page is KnowledgePageRecord => page !== null)
  }

  return {
    provider,
    buildViewer,
    denyAccess,
    accessSpace,
    accessPageSpace,
    canReadVersion,
    buildDisclosureViewer: disclosureViewerFor,
    filterReadablePages,
  }
}
