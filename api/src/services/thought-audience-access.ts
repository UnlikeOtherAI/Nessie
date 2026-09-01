import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext, ThoughtAudienceType } from '@nessie/schemas'

/**
 * Memory capture takes its audience from client-supplied `channelId` / `teamId`
 * / `projectId`. Resolving those into an audience id is pure string handling, so
 * without this check any member could write a memory into a channel, team or
 * project they do not belong to — poisoning what agents later recall for people
 * who do belong to it.
 *
 * Returns null when the actor may write to that audience, or an error code.
 */
export const checkThoughtAudienceAccess = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  audience: { audienceType: ThoughtAudienceType; audienceId: string },
): Promise<'AUDIENCE_FORBIDDEN' | null> => {
  const organizationId = actorContext.tenant.organizationId
  const userId = actorContext.actor.actorId

  // Only user actors reach this route; an agent writes memories through the
  // worker with its own resolved scopes.
  if (actorContext.actor.actorType !== 'user') return null
  // An org owner already reaches every scope in their tenant.
  if (actorContext.actor.roles?.includes('owner')) return null

  switch (audience.audienceType) {
    case 'user':
      // A private memory may only be filed against the actor themselves.
      return audience.audienceId === userId ? null : 'AUDIENCE_FORBIDDEN'
    case 'organization':
      return audience.audienceId === organizationId ? null : 'AUDIENCE_FORBIDDEN'
    case 'channel': {
      const channel = await prisma.channel.count({
        where: {
          id: audience.audienceId,
          organizationId,
          OR: [{ visibility: 'public' }, { members: { some: { userId } } }],
        },
      })
      return channel > 0 ? null : 'AUDIENCE_FORBIDDEN'
    }
    case 'team': {
      const team = await prisma.teamMember.count({
        where: {
          teamId: audience.audienceId,
          userId,
          team: { project: { organizationId } },
        },
      })
      return team > 0 ? null : 'AUDIENCE_FORBIDDEN'
    }
    case 'project': {
      const project = await prisma.projectMember.count({
        where: {
          projectId: audience.audienceId,
          userId,
          project: { organizationId },
        },
      })
      return project > 0 ? null : 'AUDIENCE_FORBIDDEN'
    }
  }
}
