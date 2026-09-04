import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

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
  return Boolean(channel && (channel.visibility === 'public' || channel.members.length > 0))
}

const canActInChannel = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  channelId: string,
): Promise<boolean> => {
  const channel = await prisma.channel.findFirst({
    where: { id: channelId, organizationId: actorContext.tenant.organizationId },
    select: {
      members: {
        where: { userId: actorContext.actor.actorId },
        select: { id: true },
        take: 1,
      },
    },
  })
  return Boolean(channel && channel.members.length > 0)
}

/** Read access is scoped by the installation's channel entitlement. */
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
  return !installation.channelId || canSeeChannel(prisma, actorContext, installation.channelId)
}

/** Manual start is scoped by the ability to act in the installation channel. */
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
  if (actorContext.actor.actorType !== 'user' || !installation.channelId) return false
  return canActInChannel(prisma, actorContext, installation.channelId)
}

/** Read gate for an individual run, matching GET /api/workflow-runs/:id. */
export const canActorReadWorkflowRun = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  workflowRunId: string,
): Promise<boolean> => {
  const run = await prisma.workflowRun.findFirst({
    where: { id: workflowRunId, organizationId: actorContext.tenant.organizationId },
    select: { installationId: true },
  })
  if (!run) return false
  return canActorReadWorkflowInstallation(prisma, actorContext, run.installationId)
}

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
