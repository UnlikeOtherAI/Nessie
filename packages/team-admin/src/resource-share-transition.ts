import { Prisma, type PrismaClient } from '@prisma/client'
import type { ResourceShareStatus } from '@nessie/schemas'

import {
  RESOURCE_SHARE_AUDIT_SELECT,
  toResourceShareTransitionResult,
  writeResourceShareLifecycleAudit,
  type ResourceShareAuditActor,
  type ResourceShareTransitionResult,
} from './resource-share-audit.js'
import {
  denyResourceShareLifecycle,
  ResourceShareLifecycleError,
} from './resource-share-lifecycle-errors.js'

const TRANSITION_SELECT = {
  ...RESOURCE_SHARE_AUDIT_SELECT,
  expiresAt: true,
  proposedRevision: true,
  recipientExternalOrgId: true,
  recipientExternalTeamId: true,
  sourceExternalTeamId: true,
  sourceExternalOrgId: true,
  targetBoardId: true,
} as const satisfies Prisma.ResourceShareSelect

export type ResourceShareTransitionRow = Prisma.ResourceShareGetPayload<{
  select: typeof TRANSITION_SELECT
}>

export const findResourceShareAtRevision = async (
  prisma: PrismaClient,
  shareId: string,
  expectedRevision: number,
): Promise<ResourceShareTransitionRow> => {
  const share = await prisma.resourceShare.findFirst({
    where: { id: shareId, revision: expectedRevision },
    select: TRANSITION_SELECT,
  })
  if (share) return share
  const exists = await prisma.resourceShare.findUnique({
    where: { id: shareId },
    select: { id: true },
  })
  if (exists) denyResourceShareLifecycle('conflict')
  throw new ResourceShareLifecycleError('not_found')
}

type TransitionInput = { shareId: string; expectedRevision: number }

export const transitionResourceShare = async (
  prisma: PrismaClient,
  input: TransitionInput,
  where: Prisma.ResourceShareWhereInput,
  data: (
    locked: ResourceShareTransitionRow,
  ) => Prisma.ResourceShareUpdateManyMutationInput,
  action: string,
  actor: ResourceShareAuditActor | null,
  requestId: string,
  reasonCode: string,
  beforeUpdate?: (
    tx: Prisma.TransactionClient,
    locked: ResourceShareTransitionRow,
  ) => Promise<void>,
): Promise<ResourceShareTransitionResult> => prisma.$transaction(async (tx) => {
  const lockedIds = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT "id"
    FROM "resource_shares"
    WHERE "id" = ${input.shareId}::uuid
      AND "revision" = ${input.expectedRevision}
    FOR UPDATE
  `)
  if (lockedIds.length !== 1) denyResourceShareLifecycle('conflict')
  const locked = await tx.resourceShare.findUnique({
    where: { id: input.shareId },
    select: TRANSITION_SELECT,
  })
  if (!locked) throw new ResourceShareLifecycleError('not_found')

  await beforeUpdate?.(tx, locked)
  const changed = await tx.resourceShare.updateMany({
    where: { id: input.shareId, revision: input.expectedRevision, ...where },
    data: { ...data(locked), revision: { increment: 1 } },
  })
  if (changed.count !== 1) denyResourceShareLifecycle('conflict')
  const row = await tx.resourceShare.findUnique({
    where: { id: input.shareId },
    select: RESOURCE_SHARE_AUDIT_SELECT,
  })
  if (!row) throw new ResourceShareLifecycleError('not_found')
  await writeResourceShareLifecycleAudit(tx, row, action, actor, requestId, {
    previousAccess: locked.effectiveAccess,
    previousStatus: locked.status as ResourceShareStatus,
    reasonCode,
  })
  return toResourceShareTransitionResult(row)
})
