import type { PrismaClient } from '@prisma/client'
import type { DisclosureViewer } from '@nessie/runtime'

/**
 * The scopes a human caller reaches, for the disclosure read predicate.
 *
 * Deliberately the same shape and the same membership sources the worker uses
 * (`worker/src/run/execute/disclosure-viewer.ts`), so a message withheld from an
 * agent's conversation window is the same message withheld from the feed. Two
 * different answers to "can this person read it?" would be a leak.
 *
 * Resolved live from membership on every call. Nothing is cached: a removal
 * from a project must take effect on the next read, which is what makes
 * revocation free of propagation.
 */
export const resolveMessageViewer = async (
  prisma: PrismaClient,
  organizationId: string,
  userId: string | null | undefined,
): Promise<DisclosureViewer> => {
  if (!userId) {
    return { kind: 'autonomous' }
  }

  const [channels, teams, projects, orgMembership] = await Promise.all([
    prisma.channelMember.findMany({
      where: { userId, channel: { organizationId } },
      select: { channelId: true },
    }),
    prisma.teamMember.findMany({
      where: { userId, team: { project: { organizationId } } },
      select: { teamId: true },
    }),
    prisma.projectMember.findMany({
      where: { userId, project: { organizationId } },
      select: { projectId: true },
    }),
    prisma.organizationMember.findFirst({
      where: { userId, organizationId },
      select: { id: true },
    }),
  ])

  return {
    kind: 'user',
    scopes: [
      { scopeId: userId, scopeType: 'user' },
      ...channels.map((row) => ({ scopeId: row.channelId, scopeType: 'channel' })),
      ...teams.map((row) => ({ scopeId: row.teamId, scopeType: 'team' })),
      ...projects.map((row) => ({ scopeId: row.projectId, scopeType: 'project' })),
      ...(orgMembership ? [{ scopeId: organizationId, scopeType: 'organization' }] : []),
    ],
    userId,
  }
}
