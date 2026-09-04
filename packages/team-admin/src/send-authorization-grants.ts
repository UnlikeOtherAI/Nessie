import { Prisma, type PrismaClient } from '@prisma/client'
import {
  CALENDAR_EVENT_CANCEL_TOOL_ID,
  CALENDAR_EVENT_CREATE_TOOL_ID,
  CALENDAR_EVENT_UPDATE_TOOL_ID,
  GMAIL_DRAFT_SEND_TOOL_ID,
} from '@nessie/runtime'
import { z } from 'zod'

export const SEND_GRANT_DURATIONS = ['10m', 'today', '30d', 'forever'] as const
export type SendGrantDuration = (typeof SEND_GRANT_DURATIONS)[number]

const STANDING_CONSENT_APPROVAL_TOOL_IDS = new Set([
  GMAIL_DRAFT_SEND_TOOL_ID,
  CALENDAR_EVENT_CREATE_TOOL_ID,
  CALENDAR_EVENT_UPDATE_TOOL_ID,
  CALENDAR_EVENT_CANCEL_TOOL_ID,
])

const ApprovalGoogleConnectionSchema = z.object({
  approvedGoogleConnectionId: z.string().uuid(),
}).passthrough()

/** Read only the account the authorization chokepoint froze with the approval. */
export const approvedGoogleConnectionForStandingConsent = (input: {
  action: string | null
  context: unknown
  toolName: string | null
}): string | null => {
  if (
    input.action !== 'tool.invoke'
    || !input.toolName
    || !STANDING_CONSENT_APPROVAL_TOOL_IDS.has(input.toolName)
  ) return null

  const parsed = ApprovalGoogleConnectionSchema.safeParse(input.context)
  return parsed.success ? parsed.data.approvedGoogleConnectionId : null
}

export const expiryForSendGrant = (
  duration: SendGrantDuration,
  now: Date,
): Date | null => {
  if (duration === 'forever') return null
  if (duration === '10m') return new Date(now.getTime() + 10 * 60 * 1000)
  if (duration === '30d') return new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
  const endOfDay = new Date(now)
  endOfDay.setHours(23, 59, 59, 999)
  return endOfDay
}

export type SendGrantInput = {
  organizationId: string
  connectionId: string
  agentId: string
  grantedByUserId: string
  duration: SendGrantDuration
  mode?: 'always' | 'judged'
  boundary?: string | null
}

export type SendGrantResult = { id: string; expiresAt: Date | null }

export type SendGrantPrisma = PrismaClient | Prisma.TransactionClient

const withSendGrantTransaction = async <T>(
  prisma: SendGrantPrisma,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> => {
  if ('$transaction' in prisma) {
    return (prisma as PrismaClient).$transaction(
      (tx) => work(tx),
      // Connection and approval changes during this write must abort consent.
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    )
  }
  return work(prisma as Prisma.TransactionClient)
}

/** The final, shared grant write. All eligibility facts are live at this point. */
const writeLiveSendAuthorization = async (
  prisma: Prisma.TransactionClient,
  input: SendGrantInput,
  now: Date,
): Promise<SendGrantResult | null> => {
  const [connection, agent] = await Promise.all([
    prisma.commsConnection.findFirst({
      where: {
        id: input.connectionId,
        organizationId: input.organizationId,
        ownerUserId: input.grantedByUserId,
        provider: 'google',
        status: 'active',
      },
      select: { id: true },
    }),
    prisma.agent.findFirst({
      where: {
        id: input.agentId,
        organizationId: input.organizationId,
        status: { not: 'offline' },
        systemManaged: false,
      },
      select: { id: true },
    }),
  ])
  if (!connection || !agent) return null

  const expiresAt = expiryForSendGrant(input.duration, now)
  return prisma.sendAuthorizationGrant.upsert({
    where: {
      connectionId_agentId: {
        connectionId: input.connectionId,
        agentId: input.agentId,
      },
    },
    create: {
      organizationId: input.organizationId,
      connectionId: input.connectionId,
      agentId: input.agentId,
      grantedByUserId: input.grantedByUserId,
      expiresAt,
      mode: input.mode ?? 'always',
      boundary: input.boundary ?? null,
    },
    update: {
      expiresAt,
      revokedAt: null,
      grantedByUserId: input.grantedByUserId,
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.boundary !== undefined ? { boundary: input.boundary } : {}),
    },
    select: { id: true, expiresAt: true },
  })
}

/**
 * Create a direct settings grant. The route owns caller visibility, while this
 * transaction owns the final live connection and agent eligibility checks.
 */
export const grantSendAuthorization = async (
  prisma: SendGrantPrisma,
  input: SendGrantInput,
  now: Date = new Date(),
): Promise<SendGrantResult | null> =>
  withSendGrantTransaction(prisma, (tx) => writeLiveSendAuthorization(tx, input, now))

export type GrantSendAuthorizationFromApprovalResult =
  | { kind: 'granted'; agentId: string; grant: SendGrantResult }
  | { kind: 'approval_not_eligible' | 'approval_unavailable' | 'target_unavailable' }

/**
 * Turn a pending send approval into standing consent without a time-of-check /
 * time-of-use gap. Approval eligibility, frozen account, and grant upsert are
 * one serializable transaction.
 */
export const grantSendAuthorizationFromApproval = async (
  prisma: SendGrantPrisma,
  input: Omit<SendGrantInput, 'agentId' | 'connectionId'> & { approvalId: string },
  now: Date = new Date(),
): Promise<GrantSendAuthorizationFromApprovalResult> =>
  withSendGrantTransaction(prisma, async (tx) => {
    const approval = await tx.approvalRequest.findFirst({
      where: {
        action: 'tool.invoke',
        expiresAt: { gt: now },
        id: input.approvalId,
        organizationId: input.organizationId,
        requiredApproverUserId: input.grantedByUserId,
        status: 'pending',
      },
      select: { action: true, agentId: true, context: true, toolName: true },
    })
    if (!approval) return { kind: 'approval_unavailable' }

    const connectionId = approvedGoogleConnectionForStandingConsent(approval)
    if (!connectionId) return { kind: 'approval_not_eligible' }

    const grant = await writeLiveSendAuthorization(tx, {
      ...input,
      agentId: approval.agentId,
      connectionId,
    }, now)
    return grant
      ? { kind: 'granted', agentId: approval.agentId, grant }
      : { kind: 'target_unavailable' }
  })
