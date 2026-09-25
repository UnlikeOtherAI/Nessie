import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import { listVisibleExecutors } from './executor-records.js'

/** The project's doorway uses the same entitled inventory, with an explicit project filter. */
export const listExecutorsForProject = async (
  prisma: PrismaClient, actor: AuthorizedActionContext, projectId: string,
) => {
  if (actor.actor.actorType !== 'user') return []
  const project = await prisma.project.findFirst({ where: {
    id: projectId, organizationId: actor.tenant.organizationId,
    OR: [{ visibility: 'public' }, { members: { some: { userId: actor.actor.actorId } } }],
  }, select: { teamId: true } })
  if (!project) return []
  const visible = await listVisibleExecutors(prisma, actor)
  const shared = await prisma.executor.findMany({ where: {
    id: { in: visible.map((entry) => entry.id) },
    OR: [
      { scopeKind: 'project', projectId },
      { projectAccess: { some: { projectId } } },
      ...(project.teamId ? [{ teamAccess: { teamId: project.teamId, everyone: true } }] : []),
    ],
  }, select: { id: true } })
  const ids = new Set(shared.map((entry) => entry.id))
  return visible.filter((entry) => ids.has(entry.id))
}
