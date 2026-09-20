import type { Prisma } from '@prisma/client'

const ACTIVE_STATUSES = ['queued', 'running', 'needs_setup'] as const

export class DeepWaterActiveRunRevocationError extends Error {
  override readonly name = 'DeepWaterActiveRunRevocationError'

  constructor(public readonly run: {
    channelId: string | null
    id: string
    status: string
  }) {
    super(
      `Deep Water run ${run.id} is still ${run.status}.`
      + (run.channelId
        ? ` Open /channels/${run.channelId}, cancel it, and retry after it becomes terminal.`
        : ' Recover the unattached run before revoking lifecycle tools.'),
    )
  }
}

export const guardDeepWaterPolicyRevocation = async (
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string
    teamId?: string
  },
): Promise<void> => {
  const run = await tx.productIntegrationRun.findFirst({
    where: {
      organizationId: input.organizationId,
      productSlug: 'deep-water',
      status: { in: [...ACTIVE_STATUSES] },
      ...(input.teamId ? { teamId: input.teamId } : {}),
    },
    orderBy: { requestedAt: 'asc' },
    select: {
      channelId: true,
      id: true,
      status: true,
    },
  })
  if (!run) return
  throw new DeepWaterActiveRunRevocationError(run)
}
