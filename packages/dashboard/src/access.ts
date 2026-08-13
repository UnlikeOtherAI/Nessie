/**
 * The one authorization chokepoint for dashboards
 * (2026-08-13-live-data-dashboards plan §9, §11.5, §11.6).
 *
 * Every read path calls `resolveDashboardAccess`: list, get, widget data,
 * source reads, embed resolution, export, realtime delivery, and every agent
 * tool. One function, many callers — a second implementation of this decision
 * is the defect Rule zero §4 names, and here it would be a bypass.
 *
 * Two independent facts decide a read, and BOTH are re-evaluated live:
 *
 *  1. may the viewer reach the *resource* (dashboard / widget / snapshot)?
 *  2. may the viewer reach the *container* it is embedded in (message, page)?
 *
 * Embedding grants nothing. A copied embedId, widgetId, or snapshot id cannot
 * bypass either half, which is why the container check lives here rather than
 * in each calling surface where it could be forgotten.
 *
 * Delegation note: this resolves who may SEE a widget, never whose credential
 * FETCHED it. External data is fetched under the source authority and shown to
 * the dashboard's audience — the owner confirmed that model, so the risk sits
 * at the share step, not here (plan §9.1).
 */

import type { PrismaClient } from '@prisma/client'

export type DashboardActor = {
  userId: string
  organizationId: string
  /** Live role from the OrganizationMember row, never an enqueue-time snapshot. */
  role: 'owner' | 'admin' | 'member'
  /** Present when the actor is an agent run acting for a user. */
  agentId?: string
}

export type DashboardCapability = 'view' | 'edit' | 'source_manage' | 'share' | 'archive'

export type DashboardAccessDecision =
  | { allowed: true; via: 'org_role' | 'home' | 'grant' | 'creator' }
  | { allowed: false; reason: 'not_found' | 'denied' }

export type DashboardResourceRef =
  | { type: 'dashboard'; id: string }
  | { type: 'widget'; id: string }
  | { type: 'widget_snapshot'; id: string }

export type DashboardContainerRef =
  | { type: 'message'; id: string }
  | { type: 'knowledge_page_version'; id: string }

/**
 * Membership lookups the resolver needs. Injected rather than imported so this
 * package does not fork channel/project/team membership rules — the caller
 * passes the same predicates the rest of the product uses.
 */
export type DashboardMembership = {
  isProjectMember: (userId: string, projectId: string) => Promise<boolean>
  isTeamMember: (userId: string, teamId: string) => Promise<boolean>
  isChannelMember: (userId: string, channelId: string) => Promise<boolean>
  canReadMessage: (userId: string, messageId: string) => Promise<boolean>
  canReadKnowledgePageVersion: (userId: string, versionId: string) => Promise<boolean>
  /** Audience grants follow membership; these resolve a subject to the actor. */
  subjectsForActor: (actor: DashboardActor) => Promise<{ type: string; id: string }[]>
}

export type ResolveDashboardAccessInput = {
  prisma: PrismaClient
  membership: DashboardMembership
  actor: DashboardActor
  resource: DashboardResourceRef
  capability: DashboardCapability
  /** Supplied when the read comes through an embed. Checked in addition. */
  container?: DashboardContainerRef
}

const DENIED: DashboardAccessDecision = { allowed: false, reason: 'denied' }
const NOT_FOUND: DashboardAccessDecision = { allowed: false, reason: 'not_found' }

type DashboardRow = {
  id: string
  organizationId: string
  home: string
  projectId: string | null
  teamId: string | null
  channelId: string | null
  ownerUserId: string | null
  createdBy: string
  archivedAt: Date | null
}

/**
 * Resolves any resource reference to its owning dashboard. Widget and snapshot
 * ids are scoped by organization here so a cross-tenant id is indistinguishable
 * from a missing one — never a bare findUnique on a caller-supplied id.
 */
const loadDashboardFor = async (
  prisma: PrismaClient,
  organizationId: string,
  resource: DashboardResourceRef,
): Promise<DashboardRow | null> => {
  if (resource.type === 'dashboard') {
    return prisma.dashboard.findFirst({
      where: { id: resource.id, organizationId },
    }) as Promise<DashboardRow | null>
  }

  if (resource.type === 'widget') {
    const widget = await prisma.dashboardWidget.findFirst({
      where: { id: resource.id, organizationId },
      select: { dashboard: true },
    })
    return (widget?.dashboard ?? null) as DashboardRow | null
  }

  const snapshot = await prisma.dashboardWidgetSnapshot.findFirst({
    where: { id: resource.id, organizationId },
    select: { dashboardId: true },
  })
  if (!snapshot) return null
  return prisma.dashboard.findFirst({
    where: { id: snapshot.dashboardId, organizationId },
  }) as Promise<DashboardRow | null>
}

const homeGrantsView = async (
  membership: DashboardMembership,
  actor: DashboardActor,
  dashboard: DashboardRow,
): Promise<boolean> => {
  switch (dashboard.home) {
    case 'organization':
      return true
    case 'project':
      return dashboard.projectId
        ? membership.isProjectMember(actor.userId, dashboard.projectId)
        : false
    case 'team':
      return dashboard.teamId ? membership.isTeamMember(actor.userId, dashboard.teamId) : false
    case 'channel':
      return dashboard.channelId
        ? membership.isChannelMember(actor.userId, dashboard.channelId)
        : false
    case 'personal':
      return dashboard.ownerUserId === actor.userId
    default:
      // An unknown home is a schema the code does not understand. Fail closed
      // rather than guessing an audience.
      return false
  }
}

const activeGrantLevel = async (
  prisma: PrismaClient,
  membership: DashboardMembership,
  actor: DashboardActor,
  resource: DashboardResourceRef,
  dashboardId: string,
): Promise<'view' | 'edit' | null> => {
  const subjects = await membership.subjectsForActor(actor)
  if (subjects.length === 0) return null

  // A grant on the dashboard covers its widgets; a widget or snapshot grant
  // covers only itself, so both the exact resource and its dashboard count.
  const resourceFilters = [
    { resourceType: 'dashboard', resourceId: dashboardId },
    { resourceType: resource.type, resourceId: resource.id },
  ]

  const grants = await prisma.dashboardGrant.findMany({
    where: {
      organizationId: actor.organizationId,
      revokedAt: null,
      OR: resourceFilters,
      AND: [
        { OR: subjects.map((subject) => ({ subjectType: subject.type, subjectId: subject.id })) },
      ],
    },
    select: { level: true, expiresAt: true },
  })

  const now = Date.now()
  const live = grants.filter((grant) => !grant.expiresAt || grant.expiresAt.getTime() > now)
  if (live.length === 0) return null
  return live.some((grant) => grant.level === 'edit') ? 'edit' : 'view'
}

const containerReadable = async (
  membership: DashboardMembership,
  actor: DashboardActor,
  container: DashboardContainerRef,
): Promise<boolean> =>
  container.type === 'message'
    ? membership.canReadMessage(actor.userId, container.id)
    : membership.canReadKnowledgePageVersion(actor.userId, container.id)

export const resolveDashboardAccess = async (
  input: ResolveDashboardAccessInput,
): Promise<DashboardAccessDecision> => {
  const { prisma, membership, actor, resource, capability, container } = input

  const dashboard = await loadDashboardFor(prisma, actor.organizationId, resource)
  if (!dashboard) return NOT_FOUND

  // An embed read must satisfy the container as well as the resource. Checked
  // first: if the viewer cannot see the message, the widget's existence is not
  // theirs to learn.
  if (container && !(await containerReadable(membership, actor, container))) {
    return NOT_FOUND
  }

  const isOwnerOrAdmin = actor.role === 'owner' || actor.role === 'admin'
  const isCreator = dashboard.createdBy === actor.userId

  // Archived dashboards are readable but frozen, so history and embeds keep
  // resolving while nothing new can be written.
  const mutating = capability !== 'view'
  if (dashboard.archivedAt && mutating && capability !== 'archive') return DENIED

  if (isOwnerOrAdmin) return { allowed: true, via: 'org_role' }

  const grantLevel = await activeGrantLevel(prisma, membership, actor, resource, dashboard.id)
  const inHome = await homeGrantsView(membership, actor, dashboard)

  switch (capability) {
    case 'view': {
      if (inHome) return { allowed: true, via: 'home' }
      if (grantLevel) return { allowed: true, via: 'grant' }
      // Not found rather than denied: a viewer with no path to a dashboard
      // should not learn that the id exists.
      return NOT_FOUND
    }
    case 'edit': {
      if (grantLevel === 'edit') return { allowed: true, via: 'grant' }
      if (isCreator && inHome) return { allowed: true, via: 'creator' }
      return inHome || grantLevel ? DENIED : NOT_FOUND
    }
    case 'share':
    case 'archive': {
      // A sharer can never grant what it does not hold, so sharing stays with
      // the creator and the org's managers rather than any editor.
      if (isCreator && inHome) return { allowed: true, via: 'creator' }
      return inHome || grantLevel ? DENIED : NOT_FOUND
    }
    case 'source_manage': {
      // Credential operations are owner/admin only and were already returned
      // above; an ordinary editor manages bindings, never secrets.
      return inHome || grantLevel ? DENIED : NOT_FOUND
    }
    default:
      return DENIED
  }
}

/** Throws the same shape a route returns, so no caller invents its own mapping. */
export class DashboardAccessError extends Error {
  constructor(readonly decision: Extract<DashboardAccessDecision, { allowed: false }>) {
    super(decision.reason)
    this.name = 'DashboardAccessError'
  }
}

export const assertDashboardAccess = async (
  input: ResolveDashboardAccessInput,
): Promise<void> => {
  const decision = await resolveDashboardAccess(input)
  if (!decision.allowed) throw new DashboardAccessError(decision)
}
