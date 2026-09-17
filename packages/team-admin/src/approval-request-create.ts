import { randomUUID } from 'node:crypto'

import type { Prisma, PrismaClient } from '@prisma/client'

import { writeAuditEntry } from '@nessie/db'
import { createApprovalUserAlerts } from '@nessie/runtime'
import type { ApprovalAction, AuthorizedActionContext } from '@nessie/schemas'

/**
 * How long an approval stands before it expires, by who is waiting on the
 * answer. This ladder used to be spelled out per door and had forked five
 * ways (30 min here, 24 h there, 7 d in two more, one inline literal); the
 * values are unchanged but now have one home and one name each.
 */

/**
 * Thirty minutes, when a run is parked on the answer. An agent is sitting in
 * a channel waiting, and a stale request there is worse than a refused one.
 */
export const APPROVAL_EXPIRY_SUSPENDED_RUN_MS = 30 * 60 * 1000

/**
 * A day, for a tool that acts as the person on an external account (a
 * connected mailbox, a calendar, a cloud browser). The run is suspended too,
 * but the only person who may answer is the one whose account is being used —
 * and thirty minutes assumes they are watching the channel right now, which a
 * send scheduled for 06:00 does not get to assume.
 */
export const APPROVAL_EXPIRY_EXTERNAL_ACCOUNT_MS = 24 * 60 * 60 * 1000

/**
 * A week, when nobody is actively waiting. A paired agent made its request
 * over HTTP and moved on, and an agent that asked for a draft to be published
 * is likewise not suspended on the answer — the person who must decide may
 * not be at a keyboard at all.
 */
export const APPROVAL_EXPIRY_UNATTENDED_MS = 7 * 24 * 60 * 60 * 1000

/**
 * How many decisions one asker may leave waiting.
 *
 * Deduplication alone is not a limit. It keys on the exact thing being decided
 * — for a publish request, the draft *version* — so an agent that edits and
 * asks again is asking about something genuinely new every time, and twenty-five
 * edit-and-ask cycles left twenty-five requests standing, each for seven days.
 * Nothing was granted, but the conversation the whole gate depends on is
 * buried, which is its own kind of failure.
 */
export const PENDING_APPROVALS_PER_REQUESTER = 10

export class TooManyPendingApprovalsError extends Error {
  constructor() {
    super(
      `There are already ${PENDING_APPROVALS_PER_REQUESTER} requests from this agent `
      + 'waiting for a person. Ask them to work through those before sending more.',
    )
    this.name = 'TooManyPendingApprovalsError'
  }
}

/**
 * Who is asking. An approval always has exactly one asker, and the two kinds
 * are not interchangeable: an in-house agent has an `Agent` row and runs inside
 * a channel, while a paired MCP credential is a program on somebody's machine
 * with no agent record and no run to suspend.
 */
export type ApprovalRequester =
  | { agentId: string }
  | { agentAccessCredentialId: string; requiredApproverUserId: string }

export type CreateApprovalInput = {
  actorContext: AuthorizedActionContext
  requester: ApprovalRequester
  action: ApprovalAction
  reason: string
  context?: Record<string, unknown>
  taskId?: string
  runId?: string
  requiredApproverRole?: string
  /**
   * Pin the request to exactly this person. A credential requester carries
   * its pin on the requester itself; an agent-opened request that acts as a
   * person (a send-as-you tool gate) sets it here.
   */
  requiredApproverUserId?: string | null
  /**
   * Tenant overrides for a request whose natural scope is the thing being
   * decided — a publish request names the page's project and team — rather
   * than whatever the caller's session claim happens to carry. Absent, they
   * default to the actor context's tenant and channel.
   */
  projectId?: string | null
  teamId?: string | null
  channelId?: string | null
  /**
   * How long the request stands. Defaults by asker kind: a suspended run gets
   * `APPROVAL_EXPIRY_SUSPENDED_RUN_MS`, a request nobody is waiting on (a
   * paired credential) gets `APPROVAL_EXPIRY_UNATTENDED_MS`.
   */
  expiresInMs?: number
  /**
   * The `tool.invoke` resumption payload. Server-authored and deliberately
   * absent from every presenter: a human sees the bounded `context` summary,
   * while the exact frozen invocation stays server-side behind the approval
   * id.
   */
  toolCallId?: string
  toolName?: string
  argsHash?: string
  resumeState?: Prisma.InputJsonValue
}

/**
 * What the dedupe predicate sees of an already-pending request. `context`
 * carries the door's own equivalence key (a publish request's page and
 * version); `toolCallId` is the run gate's.
 */
export type PendingApprovalMatch = {
  context: Record<string, unknown> | null
  toolCallId: string | null
}

/**
 * The row, shaped once.
 *
 * Every door builds an approval the same way, and a second spelling of this
 * is how the four forks drifted on the field that matters most, `requesterId`.
 */
const approvalRequestData = (input: CreateApprovalInput): Prisma.ApprovalRequestUncheckedCreateInput => {
  // Bound once, so the narrowing survives every use below.
  const credentialRequest =
    'agentAccessCredentialId' in input.requester ? input.requester : null

  return {
    organizationId: input.actorContext.tenant.organizationId,
    projectId: input.projectId !== undefined
      ? input.projectId
      : input.actorContext.tenant.projectId ?? null,
    teamId: input.teamId !== undefined
      ? input.teamId
      : input.actorContext.tenant.teamId ?? null,
    channelId: input.channelId !== undefined
      ? input.channelId
      : input.actorContext.actionContext.channelId ?? null,
    taskId: input.taskId ?? null,
    runId: input.runId ?? null,
    agentId: credentialRequest ? null : input.requester.agentId,
    agentAccessCredentialId: credentialRequest?.agentAccessCredentialId ?? null,
    // The person who lent their account is the only person who may answer for
    // it — the same pinning a send-as-you gate uses, and for the same reason:
    // a colleague must not be able to authorise something done in your name.
    requiredApproverUserId: credentialRequest
      ? credentialRequest.requiredApproverUserId
      : input.requiredApproverUserId ?? null,
    // Who asked, for the self-approval check. Never the human a credential
    // acts as: `resolveApprovalRequest` refuses a requester who tries to
    // answer their own request, so naming the approver here would make the
    // one person allowed to decide the one person who cannot. For an agent
    // the asker is the agent itself — not the actor context's actor, which a
    // delegated run stamps with the human it acts for.
    requesterId: credentialRequest
      ? credentialRequest.agentAccessCredentialId
      : input.requester.agentId,
    action: input.action,
    reason: input.reason,
    context: (input.context as Prisma.InputJsonValue) ?? undefined,
    requiredApproverRole: input.requiredApproverRole ?? null,
    toolCallId: input.toolCallId ?? null,
    toolName: input.toolName ?? null,
    argsHash: input.argsHash ?? null,
    resumeState: input.resumeState ?? undefined,
    continuationToken: randomUUID(),
    expiresAt: new Date(
      Date.now() + (input.expiresInMs
        ?? (credentialRequest
          ? APPROVAL_EXPIRY_UNATTENDED_MS
          : APPROVAL_EXPIRY_SUSPENDED_RUN_MS)),
    ),
  }
}

export const mapApprovalRequest = (approval: {
  id: string
  organizationId: string
  projectId: string | null
  teamId: string | null
  channelId: string | null
  taskId: string | null
  runId: string | null
  agentId: string | null
  agentAccessCredentialId: string | null
  requesterId: string
  action: string
  reason: string
  context: unknown
  status: string
  resolverId: string | null
  resolvedAt: Date | null
  resolution: string | null
  resolutionNote: string | null
  requiredApproverRole: string | null
  toolName: string | null
  continuationToken: string
  expiresAt: Date
  createdAt: Date
  updatedAt: Date
}) => ({
  id: approval.id,
  organizationId: approval.organizationId,
  projectId: approval.projectId,
  teamId: approval.teamId,
  channelId: approval.channelId,
  taskId: approval.taskId,
  runId: approval.runId,
  agentId: approval.agentId,
  agentAccessCredentialId: approval.agentAccessCredentialId,
  requesterId: approval.requesterId,
  action: approval.action,
  reason: approval.reason,
  context: approval.context as Record<string, unknown> | null,
  status: approval.status,
  resolverId: approval.resolverId,
  resolvedAt: approval.resolvedAt?.toISOString() ?? null,
  resolution: approval.resolution,
  resolutionNote: approval.resolutionNote,
  requiredApproverRole: approval.requiredApproverRole,
  toolName: approval.toolName,
  expiresAt: approval.expiresAt.toISOString(),
  createdAt: approval.createdAt.toISOString(),
  updatedAt: approval.updatedAt.toISOString(),
})

/**
 * Ring the bell and write the chain, after the commit.
 *
 * Both are deliberately post-transaction and deliberately non-fatal: the
 * audit write takes the organisation's chain lock of its own, so emitting
 * inside the approval transaction would couple two lock orders for no
 * correctness gain, and an approval that exists but did not ring is
 * recoverable while one rolled back because the bell failed is not.
 */
const announceApprovalCreated = async (
  prisma: PrismaClient,
  input: CreateApprovalInput,
  approvalId: string,
  stored: {
    agentId: string | null
    channelId: string | null
    projectId: string | null
    requiredApproverRole: string | null
    requiredApproverUserId: string | null
    teamId: string | null
  },
): Promise<string[]> => {
  let approvers: string[] = []
  try {
    approvers = await createApprovalUserAlerts(prisma, {
      actorAgentId: stored.agentId,
      approvalId,
      channelId: stored.channelId,
      organizationId: input.actorContext.tenant.organizationId,
      requiredApproverRole: stored.requiredApproverRole,
      // Off the stored row, not the input: what was written is what decides.
      requiredApproverUserId: stored.requiredApproverUserId,
    })
  } catch (error) {
    console.error('[approvals] could not raise alert for', approvalId, error)
  }

  try {
    await writeAuditEntry(prisma, {
      organizationId: input.actorContext.tenant.organizationId,
      projectId: stored.projectId,
      teamId: stored.teamId,
      channelId: stored.channelId,
      actorType: input.actorContext.actor.actorType as 'agent' | 'service' | 'system' | 'user',
      actorId: input.actorContext.actor.actorId,
      action: 'approval.created',
      resourceType: 'approval',
      resourceId: approvalId,
      outcome: 'success',
      metadata: {
        action: input.action,
        ...input.requester,
        // The same marker `emitAuditEvent` stamps on every credential-acted
        // row: the actor id alone cannot say a program did this rather than
        // the person. (This metadata — an action string and ids — holds
        // nothing that service's redactor would rewrite.)
        ...(input.actorContext.actionContext.agentCredentialId
          ? {
              agentCredentialId: input.actorContext.actionContext.agentCredentialId,
              via: 'mcp_agent_credential',
            }
          : {}),
      },
      requestId: input.actorContext.actionContext.requestId,
    })
  } catch {
    console.error('[audit] Failed to emit audit event:', 'approval.created', approvalId)
  }

  return approvers
}

/**
 * Open an approval, or hand back the one already open for the same thing.
 *
 * This is the one implementation every door — the API's routes and MCP
 * tools, and the worker's PA tools, tool gate and demonstration
 * generalisation — opens an approval through. It used to live in
 * `api/src/services`, which the worker cannot import, so four worker doors
 * each rolled their own and lost something different: one had no dedupe, one
 * no lock and no ceiling, one a unique-index catch and nothing else.
 *
 * What it guarantees, for every door:
 *
 * - **Atomic check-and-create.** A polling agent calls again, and
 *   find-then-create is not atomic: two calls both see no pending row and
 *   both create one, so a person gets the same decision twice. There is no
 *   unique index to lean on, because what makes two requests "the same"
 *   lives inside the approval's JSON `context`. So the check and the create
 *   happen under one `pg_advisory_xact_lock` on the caller's own key — the
 *   instrument the settings cascade and the cloud-browser admission already
 *   use for this shape of problem.
 * - **Equivalence dedupe.** `matches` says when an already-pending request is
 *   for the same thing; a second ask hands that one back instead of opening
 *   another. A door with no stable equivalence key passes `() => false` and
 *   leans on the ceiling — saying so explicitly is the point.
 * - **The per-requester ceiling**, counted inside the same lock so two
 *   concurrent asks cannot both pass it. An asker at the limit is refused
 *   rather than queued: the point is that a person is behind on decisions,
 *   and adding to the pile is the opposite of what helps. The guarantee
 *   holds per `lockKey` scope — key by requester when the ceiling must be
 *   strict.
 *
 * The alert and the audit event are emitted after the transaction commits,
 * so a slow write never holds the lock.
 */
export const createApprovalRequestOnce = async (
  prisma: PrismaClient,
  input: CreateApprovalInput & {
    /** Distinct per thing-being-decided, e.g. requester + page + version. */
    lockKey: string
    /** True when an existing pending approval is for the same thing. */
    matches: (pending: PendingApprovalMatch) => boolean
    /**
     * Runs inside the locked transaction after the dedupe and ceiling
     * checks, before the approval row is written. A proposal whose approval
     * names a thing created with it — the to-do template a publish request
     * approves — creates that thing here, so a refused or deduplicated ask
     * leaves nothing behind, and any throw aborts the whole unit, approval
     * included. A returned `context` is merged over the input's.
     */
    prepare?: (tx: Prisma.TransactionClient) => Promise<{ context?: Record<string, unknown> } | void>
  },
): Promise<{
  approval: ReturnType<typeof mapApprovalRequest>
  /** Who was told about the request; empty when it already existed. */
  approvers: string[]
  created: boolean
}> => {
  const requester = input.requester
  const created = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${input.lockKey}, 0))`

    const pending = await tx.approvalRequest.findMany({
      where: {
        action: input.action,
        organizationId: input.actorContext.tenant.organizationId,
        status: 'pending',
        ...('agentAccessCredentialId' in requester
          ? { agentAccessCredentialId: requester.agentAccessCredentialId }
          : { agentId: requester.agentId }),
      },
    })
    const existing = pending.find((row) =>
      input.matches({
        context: row.context as Record<string, unknown> | null,
        toolCallId: row.toolCallId,
      }))
    if (existing) return { approval: existing, created: false }

    if (pending.length >= PENDING_APPROVALS_PER_REQUESTER) {
      throw new TooManyPendingApprovalsError()
    }

    const prepared = await input.prepare?.(tx)
    const context = prepared?.context
      ? { ...input.context, ...prepared.context }
      : input.context

    return {
      approval: await tx.approvalRequest.create({
        data: approvalRequestData({ ...input, context }),
      }),
      created: true,
    }
  })

  if (!created.created) {
    return { approval: mapApprovalRequest(created.approval), approvers: [], created: false }
  }

  const approvers = await announceApprovalCreated(prisma, input, created.approval.id, {
    agentId: created.approval.agentId,
    channelId: created.approval.channelId,
    projectId: created.approval.projectId,
    requiredApproverRole: created.approval.requiredApproverRole,
    requiredApproverUserId: created.approval.requiredApproverUserId,
    teamId: created.approval.teamId,
  })

  return { approval: mapApprovalRequest(created.approval), approvers, created: true }
}
