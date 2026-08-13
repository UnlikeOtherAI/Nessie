/**
 * Snapshots, embed placements, and grants.
 *
 * The rule this file exists to enforce: **embedding grants nothing**. A
 * placement row records where a widget sits; it never confers the right to read
 * it. Every read runs both checks — may the viewer reach the container, and may
 * they reach the resource — so a copied embed id, widget id or snapshot id
 * bypasses neither.
 *
 * A snapshot freezes BYTES, not permission. The dataset is pinned by a foreign
 * key so retention cannot delete it out from under a quotation in a message,
 * but the right to read that quotation is re-resolved live on every view.
 */

import type { Prisma } from '@prisma/client'
import { assertDashboardAccess, resolveDashboardAccess } from '../access.js'
import type { DashboardContext } from './dashboards.js'
import { DashboardServiceError } from './dashboards.js'

export type EmbedMode = 'live' | 'static'

/**
 * Freezes a widget: its validated spec plus the exact dataset behind it, copied
 * so later edits and retention cannot change what was quoted.
 */
export const freezeWidgetSnapshot = async (
  context: DashboardContext,
  input: { widgetId: string; byAgent?: boolean },
) => {
  const { prisma, actor } = context
  await assertDashboardAccess({
    prisma,
    membership: context.membership,
    actor,
    resource: { type: 'widget', id: input.widgetId },
    capability: 'view',
  })

  const widget = await prisma.dashboardWidget.findFirst({
    where: { id: input.widgetId, organizationId: actor.organizationId },
    include: { source: { select: { latestDatasetId: true, authorityUserId: true } } },
  })
  if (!widget) {
    throw new DashboardServiceError(404, 'DASHBOARD_WIDGET_NOT_FOUND', 'widget not found')
  }
  if (!widget.source.latestDatasetId) {
    throw new DashboardServiceError(
      409,
      'DASHBOARD_NO_DATA_TO_FREEZE',
      'this widget has no data yet, so there is no moment to freeze',
    )
  }

  return prisma.dashboardWidgetSnapshot.create({
    data: {
      organizationId: actor.organizationId,
      widgetId: widget.id,
      dashboardId: widget.dashboardId,
      kind: widget.kind,
      schemaVersion: widget.schemaVersion,
      spec: widget.spec as Prisma.InputJsonValue,
      datasetId: widget.source.latestDatasetId,
      takenByType: input.byAgent ? 'agent' : 'user',
      takenById: actor.userId,
      authorityLabel: null,
    },
  })
}

/**
 * Creates a placement, after proving the actor may both read the resource and
 * post into the target.
 *
 * An agent may place a widget only where the audience can ALREADY reach it: it
 * cannot widen an audience, so if the target lacks access the caller gets
 * `DASHBOARD_SHARE_REQUIRED` and a human decides.
 */
export const createEmbedPlacement = async (
  context: DashboardContext,
  input: {
    mode: EmbedMode
    widgetId?: string
    widgetSnapshotId?: string
    targetType: 'message' | 'knowledge_page_version'
    targetId: string
    byAgent?: boolean
  },
) => {
  const { prisma, actor, membership } = context

  if (input.mode === 'live' && !input.widgetId) {
    throw new DashboardServiceError(400, 'DASHBOARD_EMBED_INVALID', 'a live embed needs a widgetId')
  }
  if (input.mode === 'static' && !input.widgetSnapshotId) {
    throw new DashboardServiceError(
      400,
      'DASHBOARD_EMBED_INVALID',
      'a static embed needs a widgetSnapshotId',
    )
  }

  const resource = input.mode === 'live'
    ? ({ type: 'widget', id: input.widgetId as string } as const)
    : ({ type: 'widget_snapshot', id: input.widgetSnapshotId as string } as const)

  await assertDashboardAccess({
    prisma,
    membership,
    actor,
    resource,
    capability: 'view',
  })

  const targetReadable = input.targetType === 'message'
    ? await membership.canReadMessage(actor.userId, input.targetId)
    : await membership.canReadKnowledgePageVersion(actor.userId, input.targetId)
  if (!targetReadable) {
    throw new DashboardServiceError(
      403,
      'DASHBOARD_EMBED_TARGET_FORBIDDEN',
      'you cannot post into that container',
    )
  }

  if (input.byAgent) {
    // An agent never widens reach. The audience must already be able to read
    // the resource, or a person has to make that call.
    const audienceHasAccess = await embedAudienceAlreadyReaches(context, {
      resource,
      targetType: input.targetType,
      targetId: input.targetId,
    })
    if (!audienceHasAccess) {
      throw new DashboardServiceError(
        409,
        'DASHBOARD_SHARE_REQUIRED',
        'the people in that conversation cannot see this dashboard yet. '
        + 'A person with sharing rights has to grant access before it can be posted there.',
      )
    }
  }

  return prisma.dashboardEmbedPlacement.create({
    data: {
      organizationId: actor.organizationId,
      mode: input.mode,
      widgetId: input.mode === 'live' ? (input.widgetId as string) : null,
      widgetSnapshotId: input.mode === 'static' ? (input.widgetSnapshotId as string) : null,
      targetType: input.targetType,
      targetId: input.targetId,
      createdBy: actor.userId,
    },
  })
}

/**
 * Whether the target's audience can already reach the resource without a new
 * grant. Conservative: a channel counts only when the dashboard's own home or
 * an explicit grant already covers that channel.
 */
const embedAudienceAlreadyReaches = async (
  context: DashboardContext,
  input: {
    resource: { type: 'widget' | 'widget_snapshot'; id: string }
    targetType: 'message' | 'knowledge_page_version'
    targetId: string
  },
): Promise<boolean> => {
  const { prisma, actor } = context

  const dashboardId = input.resource.type === 'widget'
    ? (await prisma.dashboardWidget.findFirst({
      where: { id: input.resource.id, organizationId: actor.organizationId },
      select: { dashboardId: true },
    }))?.dashboardId
    : (await prisma.dashboardWidgetSnapshot.findFirst({
      where: { id: input.resource.id, organizationId: actor.organizationId },
      select: { dashboardId: true },
    }))?.dashboardId
  if (!dashboardId) return false

  const dashboard = await prisma.dashboard.findFirst({
    where: { id: dashboardId, organizationId: actor.organizationId },
    select: { home: true, channelId: true },
  })
  if (!dashboard) return false
  // Organization-wide dashboards reach everyone in the tenant already.
  if (dashboard.home === 'organization') return true

  if (input.targetType === 'message') {
    const message = await prisma.message.findFirst({
      where: { id: input.targetId },
      select: { thread: { select: { channelId: true } } },
    })
    const channelId = message?.thread?.channelId
    if (!channelId) return false
    if (dashboard.home === 'channel' && dashboard.channelId === channelId) return true

    const grant = await prisma.dashboardGrant.findFirst({
      where: {
        organizationId: actor.organizationId,
        resourceType: 'dashboard',
        resourceId: dashboardId,
        subjectType: 'channel',
        subjectId: channelId,
        revokedAt: null,
      },
      select: { id: true },
    })
    return Boolean(grant)
  }

  const version = await prisma.knowledgePageVersion.findFirst({
    where: { id: input.targetId },
    select: { page: { select: { spaceId: true } } },
  })
  const spaceId = version?.page?.spaceId
  if (!spaceId) return false
  const grant = await prisma.dashboardGrant.findFirst({
    where: {
      organizationId: actor.organizationId,
      resourceType: 'dashboard',
      resourceId: dashboardId,
      subjectType: 'knowledge_space',
      subjectId: spaceId,
      revokedAt: null,
    },
    select: { id: true },
  })
  return Boolean(grant)
}

/**
 * Resolves an embed for a viewer. Both checks, every time — this is the single
 * read path all three surfaces share.
 */
export const resolveEmbedForViewer = async (
  context: DashboardContext,
  input: { embedId: string },
): Promise<
  | { visible: false }
  | {
    visible: true
    mode: EmbedMode
    widgetId: string | null
    widgetSnapshotId: string | null
  }
> => {
  const { prisma, actor } = context
  const placement = await prisma.dashboardEmbedPlacement.findFirst({
    where: { id: input.embedId, organizationId: actor.organizationId },
  })
  if (!placement) return { visible: false }

  const resource = placement.mode === 'live'
    ? ({ type: 'widget', id: placement.widgetId as string } as const)
    : ({ type: 'widget_snapshot', id: placement.widgetSnapshotId as string } as const)

  const decision = await resolveDashboardAccess({
    prisma,
    membership: context.membership,
    actor,
    resource,
    capability: 'view',
    container: {
      type: placement.targetType as 'message' | 'knowledge_page_version',
      id: placement.targetId,
    },
  })
  if (!decision.allowed) return { visible: false }

  return {
    visible: true,
    mode: placement.mode as EmbedMode,
    widgetId: placement.widgetId,
    widgetSnapshotId: placement.widgetSnapshotId,
  }
}

/** Replaces the placements recorded for one knowledge page version. */
export const syncKnowledgePagePlacements = async (
  context: DashboardContext,
  input: { versionId: string; embedIds: string[] },
): Promise<void> => {
  const { prisma, actor } = context
  await prisma.dashboardEmbedPlacement.deleteMany({
    where: {
      organizationId: actor.organizationId,
      targetType: 'knowledge_page_version',
      targetId: input.versionId,
      id: { notIn: input.embedIds.length > 0 ? input.embedIds : ['00000000-0000-0000-0000-000000000000'] },
    },
  })
}

export const grantDashboardAccess = async (
  context: DashboardContext,
  input: {
    dashboardId: string
    subjectType: 'user' | 'agent' | 'channel' | 'team' | 'project' | 'knowledge_space'
    subjectId: string
    level: 'view' | 'edit'
  },
) => {
  const { prisma, actor } = context
  // Sharing is its own capability: an editor cannot hand out access it was
  // given, and a sharer can never grant a level it does not hold.
  await assertDashboardAccess({
    prisma,
    membership: context.membership,
    actor,
    resource: { type: 'dashboard', id: input.dashboardId },
    capability: 'share',
  })
  if (input.level === 'edit') {
    await assertDashboardAccess({
      prisma,
      membership: context.membership,
      actor,
      resource: { type: 'dashboard', id: input.dashboardId },
      capability: 'edit',
    })
  }

  return prisma.dashboardGrant.upsert({
    where: {
      resourceType_resourceId_subjectType_subjectId: {
        resourceType: 'dashboard',
        resourceId: input.dashboardId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
      },
    },
    create: {
      organizationId: actor.organizationId,
      resourceType: 'dashboard',
      resourceId: input.dashboardId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      level: input.level,
      createdBy: actor.userId,
    },
    update: { level: input.level, revokedAt: null },
  })
}

export const revokeDashboardGrant = async (
  context: DashboardContext,
  input: { grantId: string },
) => {
  const { prisma, actor } = context
  const grant = await prisma.dashboardGrant.findFirst({
    where: { id: input.grantId, organizationId: actor.organizationId },
    select: { id: true, resourceId: true },
  })
  if (!grant) {
    throw new DashboardServiceError(404, 'DASHBOARD_GRANT_NOT_FOUND', 'grant not found')
  }
  await assertDashboardAccess({
    prisma,
    membership: context.membership,
    actor,
    resource: { type: 'dashboard', id: grant.resourceId },
    capability: 'share',
  })
  return prisma.dashboardGrant.update({
    where: { id: grant.id },
    data: { revokedAt: new Date() },
  })
}

export const listDashboardGrants = async (
  context: DashboardContext,
  input: { dashboardId: string },
) => {
  await assertDashboardAccess({
    prisma: context.prisma,
    membership: context.membership,
    actor: context.actor,
    resource: { type: 'dashboard', id: input.dashboardId },
    capability: 'view',
  })
  return context.prisma.dashboardGrant.findMany({
    where: {
      organizationId: context.actor.organizationId,
      resourceType: 'dashboard',
      resourceId: input.dashboardId,
      revokedAt: null,
    },
    orderBy: { createdAt: 'asc' },
  })
}
