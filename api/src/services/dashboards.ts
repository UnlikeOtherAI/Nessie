/**
 * Dashboard CRUD, layout, and version history.
 *
 * These functions are the ones the UI's buttons call, and — per the standing
 * rule — the ones the agent tools call too. There is no second path: an agent
 * moving a widget runs exactly the code a drag runs, so the two cannot drift in
 * behaviour or in authorization.
 *
 * Versions capture STRUCTURE only. Data has its own immutable lineage in
 * datasets and snapshots, so a version can never resurrect stale numbers.
 */

import type { Prisma, PrismaClient } from '@prisma/client'
import {
  DashboardLayoutSchema,
  DASHBOARD_GRID_COLUMNS,
  DASHBOARD_WIDGET_SIZES,
  WidgetDefinitionSchema,
  type DashboardLayout,
  type DashboardWidgetKind,
  type WidgetDefinition,
} from '@nessie/schemas'
import {
  assertDashboardAccess,
  type DashboardActor,
  type DashboardMembership,
} from '@nessie/dashboard'

export class DashboardServiceError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'DashboardServiceError'
  }
}

export type DashboardHome = 'organization' | 'project' | 'team' | 'channel' | 'personal'

export type DashboardContext = {
  prisma: PrismaClient
  membership: DashboardMembership
  actor: DashboardActor
}

const EMPTY_LAYOUT: DashboardLayout = { lg: [], md: [], sm: [] }

/**
 * The scope column that must accompany each home. Mirrors the database CHECK
 * constraint rather than replacing it: this produces a useful error, the
 * constraint guarantees no path can bypass it.
 */
type DashboardScopeColumns = Partial<
  Pick<Prisma.DashboardUncheckedCreateInput, 'projectId' | 'teamId' | 'channelId' | 'ownerUserId'>
>

const scopeColumnFor = (
  home: DashboardHome,
  input: { projectId?: string; teamId?: string; channelId?: string; userId: string },
): DashboardScopeColumns => {
  switch (home) {
    case 'organization':
      return {}
    case 'project':
      if (!input.projectId) {
        throw new DashboardServiceError(400, 'DASHBOARD_SCOPE_REQUIRED', 'projectId is required')
      }
      return { projectId: input.projectId }
    case 'team':
      if (!input.teamId) {
        throw new DashboardServiceError(400, 'DASHBOARD_SCOPE_REQUIRED', 'teamId is required')
      }
      return { teamId: input.teamId }
    case 'channel':
      if (!input.channelId) {
        throw new DashboardServiceError(400, 'DASHBOARD_SCOPE_REQUIRED', 'channelId is required')
      }
      return { channelId: input.channelId }
    case 'personal':
      return { ownerUserId: input.userId }
  }
}

/**
 * Lists everything the actor may read across the organization.
 *
 * Filters are applied only when the caller asks for them. The list is never
 * silently narrowed to a session's project or team — Rule zero §2, and the
 * specific mistake that once hid people's own documents from them.
 */
export const listDashboardsForActor = async (
  context: DashboardContext,
  filter: { home?: DashboardHome; projectId?: string } = {},
) => {
  const { prisma, actor, membership } = context
  const isManager = actor.role === 'owner' || actor.role === 'admin'

  const candidates = await prisma.dashboard.findMany({
    where: {
      organizationId: actor.organizationId,
      archivedAt: null,
      ...(filter.home ? { home: filter.home } : {}),
      ...(filter.projectId ? { projectId: filter.projectId } : {}),
    },
    orderBy: { updatedAt: 'desc' },
    take: 200,
  })
  if (isManager) return candidates

  const subjects = await membership.subjectsForActor(actor)
  const grants = await prisma.dashboardGrant.findMany({
    where: {
      organizationId: actor.organizationId,
      resourceType: 'dashboard',
      revokedAt: null,
      OR: subjects.map((subject) => ({ subjectType: subject.type, subjectId: subject.id })),
    },
    select: { resourceId: true, expiresAt: true },
  })
  const now = Date.now()
  const granted = new Set(
    grants
      .filter((grant) => !grant.expiresAt || grant.expiresAt.getTime() > now)
      .map((grant) => grant.resourceId),
  )

  const visible = await Promise.all(
    candidates.map(async (dashboard) => {
      if (granted.has(dashboard.id)) return dashboard
      switch (dashboard.home) {
        case 'organization':
          return dashboard
        case 'project':
          return dashboard.projectId
            && (await membership.isProjectMember(actor.userId, dashboard.projectId))
            ? dashboard
            : null
        case 'team':
          return dashboard.teamId && (await membership.isTeamMember(actor.userId, dashboard.teamId))
            ? dashboard
            : null
        case 'channel':
          return dashboard.channelId
            && (await membership.isChannelMember(actor.userId, dashboard.channelId))
            ? dashboard
            : null
        case 'personal':
          return dashboard.ownerUserId === actor.userId ? dashboard : null
        default:
          return null
      }
    }),
  )
  return visible.filter((dashboard): dashboard is (typeof candidates)[number] => dashboard !== null)
}

export const createDashboard = async (
  context: DashboardContext,
  input: {
    title: string
    description?: string
    home: DashboardHome
    projectId?: string
    teamId?: string
    channelId?: string
    createdByType?: 'user' | 'agent'
  },
) => {
  const { prisma, actor, membership } = context

  // Creating inside a container requires belonging to it: a dashboard's home
  // decides its default audience, so this is an audience decision.
  if (input.home === 'project' && input.projectId) {
    if (!(await membership.isProjectMember(actor.userId, input.projectId))) {
      throw new DashboardServiceError(403, 'DASHBOARD_SCOPE_FORBIDDEN', 'not a member of that project')
    }
  }
  if (input.home === 'team' && input.teamId) {
    if (!(await membership.isTeamMember(actor.userId, input.teamId))) {
      throw new DashboardServiceError(403, 'DASHBOARD_SCOPE_FORBIDDEN', 'not a member of that team')
    }
  }
  if (input.home === 'channel' && input.channelId) {
    if (!(await membership.isChannelMember(actor.userId, input.channelId))) {
      throw new DashboardServiceError(403, 'DASHBOARD_SCOPE_FORBIDDEN', 'not a member of that channel')
    }
  }
  if (input.home === 'organization' && actor.role === 'member') {
    throw new DashboardServiceError(
      403,
      'DASHBOARD_SCOPE_FORBIDDEN',
      'an organization-wide dashboard is created by an owner or admin',
    )
  }

  const scope = scopeColumnFor(input.home, { ...input, userId: actor.userId })

  return prisma.dashboard.create({
    data: {
      organizationId: actor.organizationId,
      home: input.home,
      title: input.title,
      description: input.description ?? null,
      layout: EMPTY_LAYOUT as unknown as Prisma.InputJsonValue,
      createdByType: input.createdByType ?? 'user',
      createdBy: actor.userId,
      ...scope,
    },
  })
}

export const getDashboardWithWidgets = async (context: DashboardContext, dashboardId: string) => {
  await assertDashboardAccess({
    prisma: context.prisma,
    membership: context.membership,
    actor: context.actor,
    resource: { type: 'dashboard', id: dashboardId },
    capability: 'view',
  })

  const dashboard = await context.prisma.dashboard.findFirst({
    where: { id: dashboardId, organizationId: context.actor.organizationId },
    include: { widgets: { orderBy: { createdAt: 'asc' } } },
  })
  if (!dashboard) {
    throw new DashboardServiceError(404, 'DASHBOARD_NOT_FOUND', 'dashboard not found')
  }
  return dashboard
}

/**
 * Validates a layout against the grid and each kind's declared size limits.
 *
 * The same check runs for a drag and for an agent's move tool, which is what
 * makes "an agent cannot produce a layout a person could not have dragged"
 * true rather than aspirational.
 */
export const validateLayout = (
  layout: DashboardLayout,
  widgetKinds: Map<string, DashboardWidgetKind>,
): void => {
  const parsed = DashboardLayoutSchema.parse(layout)
  for (const [breakpoint, rects] of Object.entries(parsed)) {
    const columns = DASHBOARD_GRID_COLUMNS[breakpoint as keyof typeof DASHBOARD_GRID_COLUMNS]
    for (const rect of rects) {
      const kind = widgetKinds.get(rect.widgetId)
      if (!kind) {
        throw new DashboardServiceError(
          400,
          'DASHBOARD_LAYOUT_UNKNOWN_WIDGET',
          `layout references widget ${rect.widgetId}, which is not on this dashboard`,
        )
      }
      if (rect.x + rect.w > columns) {
        throw new DashboardServiceError(
          400,
          'DASHBOARD_LAYOUT_OUT_OF_BOUNDS',
          `widget overflows the ${breakpoint} grid (${columns} columns)`,
        )
      }
      const size = DASHBOARD_WIDGET_SIZES[kind]
      if (rect.w < size.minW || rect.h < size.minH) {
        throw new DashboardServiceError(
          400,
          'DASHBOARD_LAYOUT_TOO_SMALL',
          `a ${kind} widget needs at least ${size.minW}x${size.minH}`,
        )
      }
    }
  }
}

/**
 * Composes a change summary from the operation log.
 *
 * Structural facts only — which widgets appeared, disappeared, or moved. This
 * never reads message or data content, so the no-string-matching rule does not
 * apply: nothing here is interpreting what anything means.
 */
export const summarizeChange = (
  before: { widgets: { id: string; kind: string }[]; layout: DashboardLayout },
  after: { widgets: { id: string; kind: string }[]; layout: DashboardLayout },
): string => {
  const beforeIds = new Set(before.widgets.map((widget) => widget.id))
  const afterIds = new Set(after.widgets.map((widget) => widget.id))

  const added = after.widgets.filter((widget) => !beforeIds.has(widget.id))
  const removed = before.widgets.filter((widget) => !afterIds.has(widget.id))

  const beforeRects = new Map(before.layout.lg.map((rect) => [rect.widgetId, rect]))
  const moved = after.layout.lg.filter((rect) => {
    const previous = beforeRects.get(rect.widgetId)
    if (!previous) return false
    return previous.x !== rect.x || previous.y !== rect.y
      || previous.w !== rect.w || previous.h !== rect.h
  })

  const clauses: string[] = []
  if (added.length > 0) {
    clauses.push(`added ${added.map((widget) => widget.kind).join(', ')}`)
  }
  if (removed.length > 0) {
    clauses.push(`removed ${removed.length} widget${removed.length === 1 ? '' : 's'}`)
  }
  if (moved.length > 0) {
    clauses.push(`rearranged ${moved.length} widget${moved.length === 1 ? '' : 's'}`)
  }
  if (clauses.length === 0) return 'Updated the dashboard'

  const shown = clauses.slice(0, 3).join(', ')
  const rest = clauses.length - 3
  return rest > 0 ? `${shown}, and ${rest} more change${rest === 1 ? '' : 's'}` : shown
}

/** Appends a version. History only ever grows — restore appends too. */
export const recordDashboardVersion = async (
  prisma: PrismaClient | Prisma.TransactionClient,
  input: {
    organizationId: string
    dashboardId: string
    layout: DashboardLayout
    widgets: { id: string; kind: string; spec: unknown }[]
    authorType: 'user' | 'agent'
    authorId: string
    runId?: string | null
    summary: string
  },
) => {
  const latest = await prisma.dashboardVersion.findFirst({
    where: { dashboardId: input.dashboardId },
    orderBy: { versionNumber: 'desc' },
    select: { versionNumber: true },
  })

  return prisma.dashboardVersion.create({
    data: {
      organizationId: input.organizationId,
      dashboardId: input.dashboardId,
      versionNumber: (latest?.versionNumber ?? 0) + 1,
      layout: input.layout as unknown as Prisma.InputJsonValue,
      widgets: input.widgets as unknown as Prisma.InputJsonValue,
      authorType: input.authorType,
      authorId: input.authorId,
      runId: input.runId ?? null,
      summary: input.summary,
    },
  })
}

/** Re-parses a stored spec. A row is untrusted: schema drift must not render. */
export const readStoredWidgetSpec = (spec: unknown): WidgetDefinition | null => {
  const parsed = WidgetDefinitionSchema.safeParse(spec)
  return parsed.success ? parsed.data : null
}
