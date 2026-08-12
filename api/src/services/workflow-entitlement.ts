import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

/**
 * W19 — the workflow role matrix (docs/plans/2026-08-12-workflows-first-class
 * §3.4), as one module so every workflow route asks the same questions:
 *
 * | Action                                    | Who                                            |
 * |-------------------------------------------|------------------------------------------------|
 * | Read installation, runs, run detail       | Any member entitled to the installation scope  |
 * | Start a run manually                      | Any member entitled to the installation channel|
 * | Pause / resume / uninstall an installation| Org admin or owner                             |
 * | Author, edit, publish a template          | Org admin or owner                             |
 *
 * Scope is decided by entitlement, never by the session claim (AGENTS.md Rule
 * zero #2). Read access follows the installation's scope: a channel-bound
 * installation is readable by anyone who can see that channel; a channel-less
 * installation's scope is its org (project/team narrowing is a caller's
 * explicit filter, not a silent default). Manual start is deliberately
 * stricter than read: the same channel entitlement that lets a member trigger
 * an agent there — public channels still require explicit membership to post,
 * protected/private require membership to even see.
 */

export type WorkflowInstallationScopeRow = {
  channelId: string | null
  id: string
  organizationId: string
}

export const isWorkflowAdmin = (actorContext: AuthorizedActionContext): boolean =>
  Boolean(
    actorContext.actor.roles?.includes('owner') ||
      actorContext.actor.roles?.includes('admin'),
  )

const loadInstallationScope = async (
  prisma: PrismaClient,
  organizationId: string,
  installationId: string,
): Promise<WorkflowInstallationScopeRow | null> =>
  prisma.workflowInstallation.findFirst({
    where: { id: installationId, organizationId },
    select: { channelId: true, id: true, organizationId: true },
  })

/** Can this actor see the channel at all? Public: any org member; otherwise
 *  explicit membership. Mirrors request-helpers' getVisibleChannel. */
const canSeeChannel = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  channelId: string,
): Promise<boolean> => {
  const channel = await prisma.channel.findFirst({
    where: { id: channelId, organizationId: actorContext.tenant.organizationId },
    select: {
      visibility: true,
      members: {
        where: { userId: actorContext.actor.actorId },
        select: { id: true },
        take: 1,
      },
    },
  })
  if (!channel) return false
  if (channel.visibility === 'public') return true
  return channel.members.length > 0
}

const canActInChannel = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  channelId: string,
): Promise<boolean> => {
  const channel = await prisma.channel.findFirst({
    where: { id: channelId, organizationId: actorContext.tenant.organizationId },
    select: {
      visibility: true,
      members: {
        where: { userId: actorContext.actor.actorId },
        select: { id: true },
        take: 1,
      },
    },
  })
  if (!channel) return false
  if (channel.visibility === 'protected') return channel.members.length > 0
  // Public + private: membership is required to *act* (public channels are
  // read-only until joined); a missing row never grants a mutation.
  return channel.members.length > 0
}

/** Read gate: any member entitled to the installation's scope. */
export const canActorReadWorkflowInstallation = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  installationId: string,
): Promise<boolean> => {
  const installation = await loadInstallationScope(
    prisma,
    actorContext.tenant.organizationId,
    installationId,
  )
  if (!installation) return false
  if (isWorkflowAdmin(actorContext)) return true
  if (actorContext.actor.actorType !== 'user') return false
  if (!installation.channelId) return true
  return canSeeChannel(prisma, actorContext, installation.channelId)
}

/** Manual-start gate: any member entitled to act in the installation's
 *  channel. A channel-less installation has no channel to act in, so manual
 *  start stays admin/owner-only there. */
export const canActorStartWorkflowRun = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  installationId: string,
): Promise<boolean> => {
  const installation = await loadInstallationScope(
    prisma,
    actorContext.tenant.organizationId,
    installationId,
  )
  if (!installation) return false
  if (isWorkflowAdmin(actorContext)) return true
  if (actorContext.actor.actorType !== 'user') return false
  if (!installation.channelId) return false
  return canActInChannel(prisma, actorContext, installation.channelId)
}

/** The channel entitlement filter for list endpoints: channel-less
 *  installations plus installations on channels the actor can see. Owners and
 *  admins get no filter (every row in their org). Returns null for "no
 *  filter", otherwise a where fragment. */
export const workflowInstallationEntitlementFilter = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
): Promise<{ OR: Array<{ channelId: null } | { channelId: { in: string[] } }> } | null> => {
  if (isWorkflowAdmin(actorContext)) return null
  const visibleChannels = await prisma.channel.findMany({
    where: {
      organizationId: actorContext.tenant.organizationId,
      OR: [
        { visibility: 'public' },
        { members: { some: { userId: actorContext.actor.actorId } } },
      ],
    },
    select: { id: true },
  })
  return {
    OR: [
      { channelId: null },
      { channelId: { in: visibleChannels.map((channel) => channel.id) } },
    ],
  }
}
