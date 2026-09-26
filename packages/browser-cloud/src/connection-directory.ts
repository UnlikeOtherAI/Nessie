import type { PrismaClient } from '@prisma/client'
import { resolveLiveEntitlementDecision } from '@nessie/runtime'
import type { UoaSessionIdentity } from '@nessie/schemas'

export type ConnectionDirectoryViewer = {
  organizationId: string
  userId: string
  uoaIdentity?: UoaSessionIdentity
}

/** Shared by Settings and conversational discovery. Never selects a key reference. */
export const listCloudBrowserConnectionMetadata = async (
  prisma: PrismaClient,
  input: ConnectionDirectoryViewer,
) => {
  const decision = await resolveLiveEntitlementDecision(prisma, input)
  if (decision.status === 'unavailable') throw new Error('Browser account access could not be checked.')
  if (decision.status === 'denied') throw new Error('Browser account access is no longer available.')
  const entitlement = decision.entitlements
  const membership = entitlement.kind === 'local'
    ? await prisma.organizationMember.findUnique({
        where: { organizationId_userId: { organizationId: input.organizationId, userId: input.userId } },
        select: { role: true },
      })
    : null
  const role = entitlement.kind === 'uoa' ? entitlement.organizationRole : membership?.role
  const canManageOrganization = role === 'owner' || role === 'admin'
  return prisma.cloudBrowserConnection.findMany({
    where: {
      organizationId: input.organizationId,
      OR: [
        { scope: 'organization' },
        { scope: 'user', userId: input.userId },
        {
          scope: 'team',
          ...(canManageOrganization ? {} : entitlement.kind === 'uoa'
            ? { teamId: { in: [...entitlement.teamIds] } }
            : { team: { members: { some: { userId: input.userId } } } }),
        },
      ],
    },
    select: {
      id: true, scope: true, userId: true, teamId: true, projectId: true,
      status: true, healthReason: true, healthDetail: true, createdAt: true,
    },
    orderBy: [{ scope: 'asc' }, { createdAt: 'asc' }],
  })
}
