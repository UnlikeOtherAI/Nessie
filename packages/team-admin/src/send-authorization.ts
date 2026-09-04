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

  const grant = await loadLiveSendGrant(prisma, input, now)
  // Only an `always` grant proceeds without a judgement. A `judged` grant is
  // consent to *decide*, not consent to send, so the caller must run the
  // boundary judge before anything leaves.
  return grant !== null && grant.mode === 'always'
}

export type LiveSendGrant = {
  id: string
  mode: 'always' | 'judged'
  boundary: string | null
}

/**
 * The live grant for this exact (mailbox, agent) pair, or null.
 *
 * One exact-key lookup with no wildcard, inheritance or fallback — the
 * `ScopeDisclosureGrant` discipline — plus the two structural conditions that
 * no grant can waive: an unattended run is not a person asking, and the grant
 * is only the mailbox owner's to spend.
 */
export const loadLiveSendGrant = async (
  prisma: PrismaClient,
  input: SendAuthorizationContext,
  now: Date = new Date(),
): Promise<LiveSendGrant | null> => {
  if (!input.interactive) return null

  const connection = await prisma.commsConnection.findFirst({
    where: {
      id: input.connectionId,
      organizationId: input.organizationId,
      status: 'active',
    },
    select: { ownerUserId: true },
  })
  if (!connection || connection.ownerUserId !== input.requestingUserId) {
    return null
  }

  const grant = await prisma.sendAuthorizationGrant.findUnique({
    where: {
      connectionId_agentId: {
        connectionId: input.connectionId,
        agentId: input.agentId,
      },
    },
    select: { id: true, expiresAt: true, revokedAt: true, mode: true, boundary: true },
  })
  if (!grant || grant.revokedAt !== null) return null
  if (grant.expiresAt !== null && grant.expiresAt <= now) return null
  return { id: grant.id, mode: grant.mode, boundary: grant.boundary }
}

/** Record what the assistant did, so the settings row can show its shape. */
export const recordSendDecision = async (
  prisma: PrismaClient,
  grantId: string,
  outcome: 'decided' | 'asked',
): Promise<void> => {
  await prisma.sendAuthorizationGrant.update({
    where: { id: grantId },
    data: outcome === 'decided'
      ? { decidedCount: { increment: 1 }, lastDecidedAt: new Date() }
      : { askedCount: { increment: 1 } },
  })
}

export const grantSendAuthorization = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    connectionId: string
    agentId: string
    grantedByUserId: string
    duration: SendGrantDuration
    mode?: 'always' | 'judged'
    boundary?: string | null
  },
  now: Date = new Date(),
): Promise<{ id: string; expiresAt: Date | null } | null> => {
  // Routes perform the same entitlement checks for their caller, but this is
  // the shared write boundary: no caller may create a grant for a stale Google
  // connection or an agent from another organization by bypassing route code.
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
        systemManaged: false,
      },
      select: { id: true },
    }),
  ])
  if (!connection || !agent) return null

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
      mode: input.mode ?? 'always',
      boundary: input.boundary ?? null,
    },
    // Re-granting clears a previous revocation; that is the point of granting.
    update: {
      expiresAt,
      revokedAt: null,
      grantedByUserId: input.grantedByUserId,
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.boundary !== undefined ? { boundary: input.boundary } : {}),
    },
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
  /** Which mailbox this grant is about — ambiguous without it on two accounts. */
  accountEmail: string
  mode: 'always' | 'judged'
  boundary: string | null
  decidedCount: number
  askedCount: number
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
      mode: true,
      boundary: true,
      decidedCount: true,
      askedCount: true,
      agent: { select: { name: true } },
      connection: { select: { externalUserId: true } },
    },
    orderBy: { createdAt: 'desc' },
  })
  return rows.map((row) => ({
    id: row.id,
    agentId: row.agentId,
    agentName: row.agent?.name ?? 'Agent',
    connectionId: row.connectionId,
    accountEmail: row.connection?.externalUserId ?? '',
    mode: row.mode,
    boundary: row.boundary,
    decidedCount: row.decidedCount,
    askedCount: row.askedCount,
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
export type StandingConsentDecision =
  | { outcome: 'proceed'; grantId?: string }
  /**
   * The exact Google connection the person is being asked about. Persisting it
   * on the approval prevents a later "don't ask again" click from guessing a
   * different account after the person's connections have changed.
   */
  | { outcome: 'ask'; connectionId?: string }
  /** A `judged` grant applies: the caller must run the boundary judge. */
  | { outcome: 'judge'; grantId: string; boundary: string; connectionId: string }

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
): Promise<StandingConsentDecision> => {
  if (!input.requestingUserId) return { outcome: 'ask' }

  // A calendar write is gated because it MAILS PEOPLE. With no guests to
  // notify, nobody is contacted and there is nothing for a person to approve —
  // putting lunch in your own diary should not stop a run. The tool definition
  // said this; only the chokepoint makes it true.
  if (
    input.toolName === 'calendar_event_create'
    || input.toolName === 'calendar_event_update'
  ) {
    const attendees = input.args.attendees
    if (!Array.isArray(attendees) || attendees.length === 0) {
      return { outcome: 'proceed' }
    }
  }
  // Cancelling always notifies whoever was invited, so it is only ungated when
  // the event has no guests — which the caller cannot assert, so it always asks.
  // Cancelling notifies whoever was invited and the caller cannot prove there
  // were none, so it always reaches the grant.
  //
  // Everything gated resolves against the owner's mailbox grant. Only a
  // draft-backed send can be judged: a direct send has no durable projection,
  // no hold and no undo, so it always asks whatever the grant says.
  const connectionId = await resolveGatedConnectionId(prisma, {
    ...input,
    requestingUserId: input.requestingUserId,
  })
  if (!connectionId) return { outcome: 'ask' }

  const grant = await loadLiveSendGrant(prisma, {
    organizationId: input.organizationId,
    connectionId,
    agentId: input.agentId,
    requestingUserId: input.requestingUserId,
    interactive: input.interactive,
  })
  if (!grant) return { outcome: 'ask', connectionId }
  if (grant.mode === 'always') return { outcome: 'proceed', grantId: grant.id }
  if (!grant.boundary || grant.boundary.trim().length === 0) {
    // A judged grant with no boundary has nothing to judge against, so it asks
    // rather than inventing one.
    return { outcome: 'ask' }
  }
  return {
    outcome: 'judge',
    grantId: grant.id,
    boundary: grant.boundary,
    connectionId,
  }
}

/**
 * The mailbox a gated tool call acts on.
 *
 * A draft names its connection; a calendar call does not, so it resolves the
 * caller's single active Google account — and refuses when there are two,
 * because a grant is per mailbox and guessing which one would spend the wrong
 * person's consent.
 */
const resolveGatedConnectionId = async (
  prisma: PrismaClient,
  input: {
    toolName: string
    args: Record<string, unknown>
    organizationId: string
    requestingUserId: string
  },
): Promise<string | null> => {
  if (input.toolName === 'gmail_draft_send') {
    const draftId = input.args.draftId
    if (typeof draftId !== 'string') return null
    const draft = await prisma.gmailDraftAction.findFirst({
      where: {
        id: draftId,
        organizationId: input.organizationId,
        ownerUserId: input.requestingUserId,
      },
      select: { connectionId: true },
    })
    return draft?.connectionId ?? null
  }
  if (!input.toolName.startsWith('calendar_')) return null
  const connections = await prisma.commsConnection.findMany({
    where: {
      organizationId: input.organizationId,
      ownerUserId: input.requestingUserId,
      provider: 'google',
      status: 'active',
    },
    select: { id: true },
    take: 2,
  })
  return connections.length === 1 ? (connections[0]?.id ?? null) : null
}
