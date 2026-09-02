import type { PrismaClient } from '@prisma/client'

/**
 * Standing consent for an agent to send email as a person without asking each
 * time, modelled on `ScopeDisclosureGrant`.
 *
 * Evaluation is a single exact-key lookup — no wildcard, no inheritance, no
 * fallback — so consenting for one agent implies nothing about another, and one
 * mailbox implies nothing about another. That is a structural property of the
 * query, not a rule somebody has to remember.
 */

export const SEND_GRANT_DURATIONS = ['10m', 'today', '30d', 'forever'] as const
export type SendGrantDuration = (typeof SEND_GRANT_DURATIONS)[number]

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

export type SendAuthorizationContext = {
  organizationId: string
  connectionId: string
  agentId: string
  /** The person the send would act as — must be the mailbox owner. */
  requestingUserId: string
  /** False for a trigger or schedule; those never ride a standing grant. */
  interactive: boolean
}

/**
 * Whether this specific send may proceed without asking.
 *
 * Four independent conditions, each of which alone is enough to require an
 * approval. They are checked here rather than at the call site so a new caller
 * cannot accidentally get a weaker gate.
 */
export const hasStandingSendAuthorization = async (
  prisma: PrismaClient,
  input: SendAuthorizationContext,
  now: Date = new Date(),
): Promise<boolean> => {
  // An unattended run never rides a standing grant. The consent was given for
  // "when I ask you to"; a schedule is not a person asking.
  if (!input.interactive) return false

  const connection = await prisma.commsConnection.findFirst({
    where: {
      id: input.connectionId,
      organizationId: input.organizationId,
      status: 'active',
    },
    select: { ownerUserId: true },
  })
  // The grant is the mailbox owner's to give, and only about their own mailbox.
  if (!connection || connection.ownerUserId !== input.requestingUserId) {
    return false
  }

  const grant = await prisma.sendAuthorizationGrant.findUnique({
    where: {
      connectionId_agentId: {
        connectionId: input.connectionId,
        agentId: input.agentId,
      },
    },
    select: { expiresAt: true, revokedAt: true },
  })
  if (!grant || grant.revokedAt !== null) return false
  return grant.expiresAt === null || grant.expiresAt > now
}

export const grantSendAuthorization = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    connectionId: string
    agentId: string
    grantedByUserId: string
    duration: SendGrantDuration
  },
  now: Date = new Date(),
): Promise<{ id: string; expiresAt: Date | null }> => {
  const expiresAt = expiryForSendGrant(input.duration, now)
  const row = await prisma.sendAuthorizationGrant.upsert({
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
    },
    // Re-granting clears a previous revocation; that is the point of granting.
    update: { expiresAt, revokedAt: null, grantedByUserId: input.grantedByUserId },
    select: { id: true, expiresAt: true },
  })
  return row
}

export const revokeSendAuthorization = async (
  prisma: PrismaClient,
  input: { organizationId: string; grantId: string; userId: string },
  now: Date = new Date(),
): Promise<boolean> => {
  const result = await prisma.sendAuthorizationGrant.updateMany({
    where: {
      id: input.grantId,
      organizationId: input.organizationId,
      revokedAt: null,
      // Only the mailbox owner may revoke; the grant was theirs to give.
      connection: { ownerUserId: input.userId },
    },
    data: { revokedAt: now },
  })
  return result.count === 1
}

export type SendGrantRecord = {
  id: string
  agentId: string
  agentName: string
  connectionId: string
  expiresAt: string | null
  createdAt: string
}

export const listSendAuthorizations = async (
  prisma: PrismaClient,
  input: { organizationId: string; userId: string },
  now: Date = new Date(),
): Promise<SendGrantRecord[]> => {
  const rows = await prisma.sendAuthorizationGrant.findMany({
    where: {
      organizationId: input.organizationId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      connection: { ownerUserId: input.userId },
    },
    select: {
      id: true,
      agentId: true,
      connectionId: true,
      expiresAt: true,
      createdAt: true,
      agent: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
  })
  return rows.map((row) => ({
    id: row.id,
    agentId: row.agentId,
    agentName: row.agent?.name ?? 'Agent',
    connectionId: row.connectionId,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }))
}

/**
 * Whether a structurally-gated tool call is already authorised without asking.
 *
 * Called from the tool chokepoint, so the decision sits in the one place every
 * tool execution passes through rather than in each handler. Returns false for
 * anything it does not recognise: an unknown gated tool must fall through to
 * the human gate, never past it.
 */
export const resolveStandingConsentForToolCall = async (
  prisma: PrismaClient,
  input: {
    toolName: string
    args: Record<string, unknown>
    organizationId: string
    agentId: string
    requestingUserId: string | null
    interactive: boolean
  },
): Promise<boolean> => {
  if (!input.requestingUserId) return false
  if (input.toolName !== 'gmail_draft_send') return false

  const draftId = input.args.draftId
  if (typeof draftId !== 'string') return false

  const draft = await prisma.gmailDraftAction.findFirst({
    where: {
      id: draftId,
      organizationId: input.organizationId,
      ownerUserId: input.requestingUserId,
    },
    select: { connectionId: true },
  })
  if (!draft) return false

  return hasStandingSendAuthorization(prisma, {
    organizationId: input.organizationId,
    connectionId: draft.connectionId,
    agentId: input.agentId,
    requestingUserId: input.requestingUserId,
    interactive: input.interactive,
  })
}
