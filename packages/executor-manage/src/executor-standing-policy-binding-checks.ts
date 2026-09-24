import type { PrismaClient } from '@prisma/client'
import { resolveLiveEntitlementDecision, type ResolveLiveEntitlementsDeps } from '@nessie/runtime'
import {
  isAdminRole,
  ScheduledTriggerLaunchOriginSchema,
  StandingPolicyPinnedTermsSchema,
  TicketWorkKickoffMetadataSchema,
  type RunExecuteJobPayload,
} from '@nessie/schemas'

import { EXECUTOR_LOCAL_APPS_OPERATION_KEYS } from './executor-conversation-lease.js'
import { executorHeartbeatCutoff } from './executor-liveness.js'
import { jobServesTicketWork } from './executor-standing-policy-fence.js'
import { loadTicketWorkLimitState, ticketWorkLimitBreachOf } from './executor-standing-policy-limits.js'
import { standingPolicyMachineDigests } from './executor-standing-policy-machines.js'
import { standingPolicyLimitsOf, standingPolicyTermsDigest, standingPolicyTermsOf } from './executor-standing-policy-terms.js'

/**
 * The seven checks every standing bind runs again
 * (docs/plans/2026-09-23-ticket-driven-agents/machine-access.md → "Binding at
 * each wake"), each its own refusal reason:
 *
 * 1. `policy_not_live` — the policy is `live` and names this trigger, agent
 *    and machine;
 * 2. `terms_changed` — the trigger still digests to what was pinned, and the
 *    machine to its pinned descriptor digests;
 * 3. `author_unavailable` — the author is re-resolved live with UOA, failing
 *    closed and never from a cache, is not deactivated, can still edit the
 *    board, and the origin captured at confirm still verifies;
 * 4. `machine_unavailable` — the machine is online, not paused or revoked,
 *    still private to the author, and the agent's assignment and grant hold;
 * 5. `channel_unavailable` — the target channel is still live, ordinary and
 *    public in the project, with the agent bound, and the run is in the work
 *    thread;
 * 6. `not_this_work` — every message the run consumes is a `ticket.work`
 *    kickoff for this record;
 * 7. `limit_reached` — the record is within its limits.
 */

export type StandingPolicyRefusalReason =
  | 'policy_not_live'
  | 'terms_changed'
  | 'author_unavailable'
  | 'machine_unavailable'
  | 'channel_unavailable'
  | 'not_this_work'
  | 'limit_reached'

/**
 * What the run and the project's audience are told. None names the machine:
 * the work thread is a public room, and the machine is its owner's to name.
 */
export const STANDING_POLICY_REFUSAL_SENTENCES: Record<StandingPolicyRefusalReason, string> = {
  policy_not_live: 'The machine access this ticket\'s work runs under is no longer live, so no machine is bound this turn.',
  terms_changed: 'The trigger or the machine\'s reviewed configuration changed since its owner confirmed machine access, '
    + 'so no machine is bound this turn.',
  author_unavailable: 'The machines\' owner could not be confirmed as still able to give this board their machines, so no '
    + 'machine is bound this turn.',
  machine_unavailable: 'The machine is offline or no longer offers you its coding tools, so no machine is bound this turn.',
  channel_unavailable: 'This ticket\'s work thread is no longer in a public channel of the project that you are in, so no '
    + 'machine is bound this turn.',
  not_this_work: 'This turn answers something other than this ticket\'s own wake, so no machine is bound.',
  limit_reached: 'This ticket\'s work reached one of its limits and stopped, so no machine is bound.',
}

export type StandingPolicyBinderDeps = {
  /**
   * Whether the author can still edit the ticket's board: team-admin's
   * `canMemberEditProjectBoards`, handed in because that rule lives above this
   * package. `isOrganizationAdmin` is UOA's live answer, when it gave one.
   */
  canEditBoard: (input: {
    isOrganizationAdmin?: boolean
    organizationId: string
    projectId: string
    userId: string
  }) => Promise<boolean>
  /** The live UOA lookup's transport; tests stand one in. */
  entitlements?: ResolveLiveEntitlementsDeps
}

export type StandingBindRecord = {
  agentId: string
  executorId: string | null
  id: string
  organizationId: string
  policyId: string | null
  projectId: string
  startedByEventId: string | null
  startedByUserId: string | null
  taskId: string
  threadId: string
  triggerId: string | null
}

export type CheckedStandingPolicy = {
  authorUserId: string
  executors: Array<{ descriptorConfigDigest: string; executorId: string; localPolicyDigest: string }>
  id: string
  triggerDigest: string
}

type Checked = { ok: true; policy: CheckedStandingPolicy } | { ok: false; reason: StandingPolicyRefusalReason }

const refused = (reason: StandingPolicyRefusalReason): Checked => ({ ok: false, reason })

const authorStillStands = async (
  prisma: PrismaClient,
  input: { authorOrigin: unknown; authorUserId: string; organizationId: string; projectId: string },
  deps: StandingPolicyBinderDeps,
): Promise<boolean> => {
  const origin = ScheduledTriggerLaunchOriginSchema.safeParse(input.authorOrigin)
  if (!origin.success || origin.data.userId !== input.authorUserId
    || origin.data.organizationId !== input.organizationId) return false
  const team = await prisma.team.findFirst({
    where: {
      id: origin.data.teamId,
      members: { some: { userId: input.authorUserId } },
      project: { organizationId: input.organizationId },
    },
    select: { id: true },
  })
  if (!team) return false
  const live = await resolveLiveEntitlementDecision(prisma, {
    organizationId: input.organizationId,
    userId: input.authorUserId,
    ...(origin.data.uoaIdentity ? { uoaIdentity: origin.data.uoaIdentity } : {}),
  }, deps.entitlements)
  if (live.status !== 'allowed') return false
  return deps.canEditBoard({
    organizationId: input.organizationId,
    projectId: input.projectId,
    userId: input.authorUserId,
    ...(live.entitlements.kind === 'uoa' ? { isOrganizationAdmin: isAdminRole(live.entitlements.organizationRole) } : {}),
  })
}

const machineStillOffered = async (
  prisma: PrismaClient,
  input: { agentId: string; authorUserId: string; executorId: string; now: Date; organizationId: string },
): Promise<boolean> => {
  const executor = await prisma.executor.findFirst({
    where: { id: input.executorId, organizationId: input.organizationId, removedAt: null },
    select: {
      lastSeenAt: true, pairingOwnerUserId: true, scopeKind: true, status: true,
      operationGrants: {
        where: { agentId: input.agentId, operationKey: { in: [...EXECUTOR_LOCAL_APPS_OPERATION_KEYS] }, state: 'allowed' },
        select: { operationKey: true },
      },
      privateAssignments: {
        where: { agentId: input.agentId, principalKind: 'agent', role: 'use' }, select: { id: true },
      },
    },
  })
  return Boolean(executor
    && executor.status === 'online' && executor.lastSeenAt && executor.lastSeenAt >= executorHeartbeatCutoff(input.now)
    && executor.scopeKind === 'private' && executor.pairingOwnerUserId === input.authorUserId
    && executor.privateAssignments.length > 0
    && EXECUTOR_LOCAL_APPS_OPERATION_KEYS.every((key) => (
      executor.operationGrants.some((grant) => grant.operationKey === key))))
}

const channelStillPublic = async (
  prisma: PrismaClient,
  input: { record: StandingBindRecord; runId: string; targetChannelId: string | null },
): Promise<boolean> => {
  if (!input.targetChannelId) return false
  const [channel, thread, run] = await Promise.all([
    prisma.channel.findFirst({
      where: { archivedAt: null, deletedAt: null, id: input.targetChannelId },
      select: {
        dmKey: true, projectId: true, systemChannelType: true, type: true, visibility: true,
        _count: { select: { agentBindings: { where: { agentId: input.record.agentId } } } },
      },
    }),
    prisma.thread.findUnique({ where: { id: input.record.threadId }, select: { channelId: true } }),
    prisma.run.findUnique({ where: { id: input.runId }, select: { threadId: true } }),
  ])
  return Boolean(channel && channel.type === 'standard' && channel.visibility === 'public'
    && !channel.systemChannelType && !channel.dmKey && channel.projectId === input.record.projectId
    && channel._count.agentBindings > 0
    && thread?.channelId === input.targetChannelId && run?.threadId === input.record.threadId)
}

const consumesOnlyThisWork = async (
  prisma: PrismaClient,
  input: { job: RunExecuteJobPayload; record: StandingBindRecord; runId: string },
): Promise<boolean> => {
  const { job, record } = input
  if (!jobServesTicketWork(job, record)) return false
  const run = await prisma.run.findUnique({
    where: { id: input.runId }, select: { agentId: true, triggerMessageId: true },
  })
  if (!run || run.agentId !== record.agentId || run.triggerMessageId !== job.messageId) return false
  const ids = [...new Set([job.messageId, ...(job.batchMessageIds ?? [])])]
  const messages = await prisma.message.findMany({
    where: { id: { in: ids } },
    select: { deletedAt: true, metadata: true, role: true, threadId: true, userId: true },
  })
  return messages.length === ids.length && messages.every((message) => {
    const metadata = message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
      ? (message.metadata as Record<string, unknown>)['ticketWorkKickoff']
      : undefined
    const kickoff = TicketWorkKickoffMetadataSchema.safeParse(metadata)
    return message.role === 'system' && message.userId === null && message.deletedAt === null
      && message.threadId === record.threadId && kickoff.success && kickoff.data.workId === record.id
  })
}

export const checkStandingPolicyBindingFacts = async (
  prisma: PrismaClient,
  input: { job: RunExecuteJobPayload; record: StandingBindRecord; runId: string },
  deps: StandingPolicyBinderDeps,
  now: Date,
): Promise<Checked> => {
  const { record } = input
  const executorId = record.executorId
  const policy = record.policyId
    ? await prisma.executorStandingPolicy.findUnique({
        where: { id: record.policyId },
        select: {
          agentId: true, authorOrigin: true, authorUserId: true, id: true, organizationId: true, pinnedTerms: true,
          status: true, triggerDigest: true, triggerId: true,
          executors: { select: { descriptorConfigDigest: true, executorId: true, localPolicyDigest: true } },
        },
      })
    : null
  // 1.
  if (!executorId || !policy || policy.status !== 'live' || policy.triggerId !== record.triggerId
    || policy.agentId !== record.agentId || policy.organizationId !== record.organizationId
    || !policy.executors.some((row) => row.executorId === executorId)) return refused('policy_not_live')
  // 2.
  const [trigger, digests] = await Promise.all([
    record.triggerId
      ? prisma.agentTrigger.findUnique({
          where: { id: record.triggerId },
          select: { agentId: true, config: true, enabled: true, status: true, targetChannelId: true },
        })
      : null,
    standingPolicyMachineDigests(prisma, executorId),
  ])
  const pinned = StandingPolicyPinnedTermsSchema.safeParse(policy.pinnedTerms)
  const terms = trigger && pinned.success ? standingPolicyTermsOf(trigger, standingPolicyLimitsOf(pinned.data)) : null
  const row = policy.executors.find((entry) => entry.executorId === executorId)
  if (!trigger?.enabled || trigger.status !== 'active' || !terms || standingPolicyTermsDigest(terms) !== policy.triggerDigest
    || !digests || digests.descriptorConfigDigest !== row?.descriptorConfigDigest
    || digests.localPolicyDigest !== row.localPolicyDigest) return refused('terms_changed')
  // 3.
  if (!await authorStillStands(prisma, {
    authorOrigin: policy.authorOrigin, authorUserId: policy.authorUserId, organizationId: record.organizationId,
    projectId: record.projectId,
  }, deps)) return refused('author_unavailable')
  // 4.
  if (!await machineStillOffered(prisma, {
    agentId: record.agentId, authorUserId: policy.authorUserId, executorId, now, organizationId: record.organizationId,
  })) return refused('machine_unavailable')
  // 5.
  if (!await channelStillPublic(prisma, { record, runId: input.runId, targetChannelId: trigger.targetChannelId })) {
    return refused('channel_unavailable')
  }
  // 6.
  if (!await consumesOnlyThisWork(prisma, input)) return refused('not_this_work')
  // 7.
  if (ticketWorkLimitBreachOf(await loadTicketWorkLimitState(prisma, { now, workId: record.id }))) {
    return refused('limit_reached')
  }
  return {
    ok: true,
    policy: {
      authorUserId: policy.authorUserId,
      executors: policy.executors,
      id: policy.id,
      triggerDigest: policy.triggerDigest,
    },
  }
}
