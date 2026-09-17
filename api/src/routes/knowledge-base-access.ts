import type { FastifyReply, FastifyRequest } from 'fastify'
import {
  buildNativeSourceRef,
  buildSpaceSourceRef,
  canReadKnowledgePageVersion,
  canReadSpace,
  canWriteSpace,
  createNativeKnowledgeProvider,
  isAgentCoreDocumentPage,
  knowledgeEmbeddingJobKey,
  loadSpaceViewer,
  viewerHoldsPageShare,
  type KnowledgePageRecord,
  type KnowledgeProvider,
  type KnowledgeSpaceRecord,
  type SpaceViewer,
  type SpaceViewerPrincipal,
} from '@nessie/knowledge'
import { AgentEditAuthorityError, assertAgentFieldAuthority } from '@nessie/runtime'
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

  // The person-to-person share arm of the two access modes, and the only place
  // a `KnowledgePageShare` ever widens anything. `viewerHoldsPageShare` carries
  // the preconditions; a caller that needs the owner's own authority asks
  // `requirePageOwnerWrite` instead.
  const pageShareAllows = (
    actorContext: AuthorizedActionContext,
    page: KnowledgePageRecord,
    viewer: SpaceViewer,
    mode: 'read' | 'write',
  ): Promise<boolean> => viewerHoldsPageShare(prisma, {
    organizationId: actorContext.tenant.organizationId,
    actorType: actorContext.actor.actorType,
    page,
    viewer,
    minimum: mode === 'read' ? 'view' : 'edit',
  })

  // Enforces access on the space a page belongs to, plus the page-level share
  // arm for a person the owner shared this page (or an ancestor folder) with.
  const accessPageSpace = async (
    actorContext: AuthorizedActionContext,
    page: KnowledgePageRecord,
    viewer: SpaceViewer,
    mode: 'read' | 'write',
    reply: FastifyReply,
  ): Promise<boolean> => {
    const space = await provider.getSpace(actorContext.tenant.organizationId, page.spaceId)
    if (!space) {
      sendApiError(reply, 404, 'KNOWLEDGE_SPACE_NOT_FOUND', 'Space not found')
      return false
    }
    const spaceAllows = mode === 'read' ? canReadSpace(space, viewer) : canWriteSpace(space, viewer)
    if (!spaceAllows && !(await pageShareAllows(actorContext, page, viewer, mode))) {
      denyAccess(reply, mode === 'read' ? 'NOT_A_SPACE_MEMBER' : 'WRITE_NOT_PERMITTED')
      return false
    }

    // Unversioned page metadata and annotations inherit every retained
    // version's source boundary. Letting an editor alter such a page without
    // reading its history would create a disclosure bypass. A share never
    // reaches past it: the basis check runs for a grantee exactly as it does
    // for a member, which is why an `edit` grant cannot open a version the
    // recipient could not already have been shown.
    if (await canReadPageVersion(viewer, page)) return true
    denyAccess(reply, 'VERSION_SOURCE_RESTRICTED')
    return false
  }

  /**
   * Write access that ignores shares entirely: the acts that stay the owner's
   * however generously they shared a page — publish, move, archive, and the
   * share routes themselves.
   *
   * Publishing is the owner's statement that a version is current; the tree and
   * the audience are the owner's structure. An editor who could publish would
   * replace the owner's published version without an act of theirs, and an
   * editor who could re-share would make the owner's "Has access" list stop
   * being the truth.
   */
  const requirePageOwnerWrite = async (
    actorContext: AuthorizedActionContext,
    page: KnowledgePageRecord,
    viewer: SpaceViewer,
    reply: FastifyReply,
  ): Promise<boolean> => {
    if ((await accessSpace(actorContext, page.spaceId, viewer, 'write', reply)) === null) return false
    if (await canReadPageVersion(viewer, page)) return true
    denyAccess(reply, 'VERSION_SOURCE_RESTRICTED')
    return false
  }

  /**
   * `POST /spaces/:spaceId/pages` for a recipient of an `edit` share: creating
   * inside a shared folder is writing inside the grant's subtree, so it is
   * allowed, while creating at the space root never consults shares at all.
   *
   * The new page is created by the recipient (`createdBy`) in the owner's space
   * with the owner's scope columns, and inherits the folder's share reach
   * through the ancestor walk rather than through a row of its own.
   */
  const accessSpaceForPageCreate = async (
    actorContext: AuthorizedActionContext,
    spaceId: string,
    viewer: SpaceViewer,
    parentPageId: string | null | undefined,
    reply: FastifyReply,
  ): Promise<KnowledgeSpaceRecord | null> => {
    const space = await provider.getSpace(actorContext.tenant.organizationId, spaceId)
    if (!space) {
      sendApiError(reply, 404, 'KNOWLEDGE_SPACE_NOT_FOUND', 'Space not found')
      return null
    }
    if (canWriteSpace(space, viewer)) return space
    if (parentPageId) {
      const parent = await provider.getPage(actorContext.tenant.organizationId, parentPageId)
      // The parent must live in the space being written to; otherwise an edit
      // share on a page in one space would authorize a create in another.
      if (
        parent
        && parent.spaceId === spaceId
        && (await pageShareAllows(actorContext, parent, viewer, 'write'))
      ) {
        return space
      }
    }
    denyAccess(reply, 'WRITE_NOT_PERMITTED')
    return null
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
    accessSpaceForPageCreate,
    accessPageSpace,
    // Exposed because a surface that has already settled *whether* a caller may
    // proceed sometimes still has to answer *how far*: the spreadsheet
    // bootstrap tells the pane whether to open writable, and a share is the
    // second way that can be true. Never a substitute for `accessPageSpace` —
    // it answers only the share half and enforces nothing.
    pageShareAllows,
    canReadVersion,
    canReadPageVersionsWithViewer,
    requirePageOwnerWrite,
    buildDisclosureViewer: disclosureViewerFor,
    filterReadablePages,
  }
}

/**
 * Generic Knowledge paths remain the one editor/history surface, but a page
 * mapped as an agent core document takes the agent's live, field-sensitive
 * authority with it. Space write access alone can never rewrite a persona.
 */
export const requireAgentCoreDocumentEditAuthority = async (
  deps: KnowledgeRouteDeps,
  actorContext: AuthorizedActionContext,
  pageId: string,
  reply: FastifyReply,
): Promise<boolean> => {
  const core = await isAgentCoreDocumentPage(deps.prisma, pageId)
  if (!core) return true
  if (actorContext.actor.actorType !== 'user') {
    sendApiError(reply, 403, 'AGENT_CORE_HUMAN_EDIT_REQUIRED', 'Only an authorized person may edit active agent instructions')
    return false
  }
  const agent = await deps.prisma.agent.findFirst({
    where: { id: core.agentId, organizationId: actorContext.tenant.organizationId },
    select: {
      id: true,
      organizationId: true,
      ownerUserId: true,
      systemManaged: true,
      todosEnabled: true,
      visibility: true,
    },
  })
  if (!agent) {
    sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
    return false
  }
  try {
    // `assertAgentFieldAuthority` resolves the live entitlement before the
    // provider begins its write transaction. The mutable page writer then uses
    // a revision CAS, preventing a stale editor from racing a newer human edit.
    await assertAgentFieldAuthority(deps.prisma, {
      organizationId: actorContext.tenant.organizationId,
      uoaIdentity: actorContext.actionContext.uoaIdentity,
      userId: actorContext.actor.actorId,
    }, agent, {})
    return true
  } catch (error) {
    if (error instanceof AgentEditAuthorityError) {
      sendApiError(reply, 403, error.code, error.message)
      return false
    }
    throw error
  }
}
