import { Prisma } from '@prisma/client'

/** A launcher run still open: Ledger work may be in flight through the tools it was granted. */
const LEGACY_ACTIVE_STATUSES = ['queued', 'running', 'needs_setup'] as const

/** An agent's brief that has not been launched: only that agent can still carry it on. */
const UNLAUNCHED_BRIEF_STATUSES = ['queued', 'drafting'] as const

export class DeepWaterActiveRunRevocationError extends Error {
  override readonly name = 'DeepWaterActiveRunRevocationError'

  constructor(public readonly run: {
    channelId: string | null
    id: string
    originKind: string
    requestedByUserId: string | null
    status: string
  }) {
    // Never the topic: the run is named by id and status, and the remedy is
    // DeepWater's app page, where a team owner or admin can cancel it (N8.5).
    super(
      `A DeepWater research (${run.id}) that needs these tools is still ${run.status}.`
      + ' Cancel it from DeepWater in Apps, or let it finish, then try again.',
    )
  }

  /** The open run a Cancel action names: never its topic. */
  get details(): DeepWaterActiveRunDetails {
    return {
      run: {
        id: this.run.id,
        status: this.run.status,
        originKind: this.run.originKind,
        requestedByUserId: this.run.requestedByUserId,
      },
    }
  }
}

/** What a 409 for an open research carries, so the app page can offer Cancel (N8.5). */
export type DeepWaterActiveRunDetails = {
  run: { id: string; status: string; originKind: string; requestedByUserId: string | null }
}

/**
 * Which open runs a revocation must wait for (Water plan amendments N8.4, C4).
 *
 * - `legacy` — launcher runs (`uoa_identity IS NULL`) that are still open.
 *   Their Personal Assistant handoff dispatches through the granted tools, so
 *   revoking or removing a tool would strand them. The contract upgrade and the
 *   org-wide updater revocation use it.
 * - `agent` — the legacy runs, plus the agent's own briefs that have not been
 *   launched: an agent-origin brief is carried on only by the agent that opened
 *   it. Per-agent revocation uses it. A launched brief never blocks (Ledger and
 *   the watch finish it without the agent), and a person's brief never does.
 */
export type DeepWaterRevocationGuardMode =
  | { kind: 'legacy' }
  | { kind: 'agent'; agentId: string }

export const guardDeepWaterPolicyRevocation = async (
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string
    teamId?: string
    mode: DeepWaterRevocationGuardMode
  },
): Promise<void> => {
  const legacy: Prisma.ProductIntegrationRunWhereInput = {
    uoaIdentity: { equals: Prisma.DbNull },
    status: { in: [...LEGACY_ACTIVE_STATUSES] },
  }
  const unlaunchedAgentBriefs: Prisma.ProductIntegrationRunWhereInput[] = input.mode.kind === 'agent'
    ? [{
        originKind: 'agent',
        originAgentId: input.mode.agentId,
        status: { in: [...UNLAUNCHED_BRIEF_STATUSES] },
      }]
    : []
  const run = await tx.productIntegrationRun.findFirst({
    where: {
      organizationId: input.organizationId,
      productSlug: 'deep-water',
      ...(input.teamId ? { teamId: input.teamId } : {}),
      OR: [legacy, ...unlaunchedAgentBriefs],
    },
    orderBy: { requestedAt: 'asc' },
    select: {
      channelId: true,
      id: true,
      originKind: true,
      requestedByUserId: true,
      status: true,
    },
  })
  if (!run) return
  throw new DeepWaterActiveRunRevocationError(run)
}
