import type { PrismaClient } from '@prisma/client'
import {
  assessStandingPolicyMachine,
  executorsAdministeredBy,
  offersReviewedCodingSessions,
} from '@nessie/executor-manage'
import {
  ExecutorCapabilityDescriptorSchema,
  ExecutorStandingPolicyEndedReasonSchema,
  ExecutorStandingPolicyStatusSchema,
  ExecutorStandingPolicySuspendedReasonSchema,
  STANDING_POLICY_LIMIT_CEILINGS,
  StandingPolicyHostProfileSchema,
  StandingPolicyPinnedTermsSchema,
  TICKET_WORK_LIVE_STATUSES,
  TicketWorkStateReasonSchema,
  TicketWorkStatusSchema,
  type StandingPolicyMachineOption,
  type TriggerMachineAccessState,
  type TriggerMachineAccessView,
} from '@nessie/schemas'

import { agentTriggerScopeWhere } from './trigger-lifecycle.js'
import { ticketWorkThreadTitle } from './ticket-work-thread.js'

/**
 * What a ticket trigger's Machine access section reads, and the machines its
 * author may offer (docs/standards/ticket-work-machine-access.md → "What the
 * screens show"). The section is on the trigger's own page, which only the
 * Triggers routes' readers and the author reach; a machine is named only to
 * the author and to the people who administer it, and every live ticket of
 * the trigger is listed by its own title, which its work thread already
 * carries in the project's room.
 */

const authorOf = (config: unknown): string | null => {
  const stored = config && typeof config === 'object' ? (config as { authorUserId?: unknown }).authorUserId : undefined
  return typeof stored === 'string' ? stored : null
}

const stateOf = (status: string | null): TriggerMachineAccessState => {
  switch (status) {
    case 'preparing': return 'awaiting_confirmation'
    case 'live': return 'live'
    case 'suspended': return 'suspended'
    case 'ended': return 'ended'
    default: return 'not_set_up'
  }
}

const POLICY_SELECT = {
  authorUserId: true, confirmedAt: true, createdAt: true, endedAt: true, endedReason: true, hostProfile: true,
  id: true, pinnedTerms: true, status: true, suspendedReason: true,
  endedBy: { select: { displayName: true } },
  executors: { orderBy: { position: 'asc' as const }, select: { executor: { select: { id: true, label: true } } } },
} as const

/**
 * Where the card of a `preparing` policy can be answered: the conversation a
 * review card for its access change was posted to (the Designer's or the
 * Personal Assistant's DM with its author), or this page, whose card lives
 * only while the page that prepared it is open.
 */
const cardLocationOf = async (
  prisma: PrismaClient,
  policyId: string | null,
): Promise<TriggerMachineAccessView['cardLocation']> => {
  if (!policyId) return null
  const card = await prisma.agentCard.findFirst({
    where: {
      executorAccessChange: { revisions: { equals: policyId, path: ['change', 'policyId'] }, status: 'pending' },
      status: 'open',
    },
    orderBy: { createdAt: 'desc' },
    select: { channelId: true, threadId: true },
  })
  return card ? { channelId: card.channelId, threadId: card.threadId, where: 'conversation' } : { where: 'this_page' }
}

/** A ticket trigger's machine access, for someone who may read its page; null when it is no ticket trigger here. */
export const loadTriggerMachineAccess = async (
  prisma: PrismaClient,
  input: { organizationId: string; triggerId: string; viewerUserId: string },
): Promise<TriggerMachineAccessView | null> => {
  const trigger = await prisma.agentTrigger.findFirst({
    where: agentTriggerScopeWhere({ organizationId: input.organizationId, triggerId: input.triggerId }),
    select: { config: true, id: true, type: true },
  })
  if (!trigger || trigger.type !== 'ticket_changed') return null
  const authorUserId = authorOf(trigger.config)
  const author = authorUserId
    ? await prisma.user.findUnique({ where: { id: authorUserId }, select: { displayName: true, id: true } })
    : null
  const policies = await prisma.executorStandingPolicy.findMany({
    where: { organizationId: input.organizationId, triggerId: trigger.id },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: POLICY_SELECT,
  })
  // The one that binds, else the card still out, else the newest ended.
  const binding = policies.find((policy) => policy.status === 'live' || policy.status === 'suspended')
  const preparing = policies.find((policy) => policy.status === 'preparing')
  const shown = binding ?? preparing ?? policies[0] ?? null
  const executorIds = shown?.executors.map((row) => row.executor.id) ?? []
  const viewerIsAuthor = authorUserId === input.viewerUserId
  const administered = await executorsAdministeredBy(prisma, {
    executorIds, organizationId: input.organizationId, userId: input.viewerUserId,
  })
  const namesMachines = viewerIsAuthor || administered.size > 0
  const labels = new Map(shown?.executors.map((row) => [row.executor.id, row.executor.label]) ?? [])
  const terms = StandingPolicyPinnedTermsSchema.safeParse(shown?.pinnedTerms)
  const profile = StandingPolicyHostProfileSchema.safeParse(shown?.hostProfile)
  const records = await prisma.agentTicketWork.findMany({
    where: { status: { in: [...TICKET_WORK_LIVE_STATUSES] }, triggerId: trigger.id },
    orderBy: [{ queuePosition: 'asc' }, { startedAt: 'asc' }],
    take: 50,
    select: {
      executorId: true, id: true, projectId: true, queuePosition: true, stateReason: true, status: true, taskId: true,
      task: { select: { externalLink: { select: { externalKey: true } }, title: true } },
    },
  })
  const status = shown ? ExecutorStandingPolicyStatusSchema.parse(shown.status) : null
  const suspended = ExecutorStandingPolicySuspendedReasonSchema.safeParse(shown?.suspendedReason)
  const ended = ExecutorStandingPolicyEndedReasonSchema.safeParse(shown?.endedReason)
  return {
    triggerId: trigger.id,
    state: stateOf(status),
    author: author ? { name: author.displayName, userId: author.id } : null,
    viewerIsAuthor,
    policy: shown && status ? {
      id: shown.id,
      status,
      suspendedReason: suspended.success ? suspended.data : null,
      endedReason: ended.success ? ended.data : null,
      endedAt: shown.endedAt?.toISOString() ?? null,
      endedByName: shown.endedBy?.displayName ?? null,
      confirmedAt: shown.confirmedAt?.toISOString() ?? null,
      createdAt: shown.createdAt.toISOString(),
      machineCount: Math.min(2, Math.max(1, shown.executors.length)),
      machines: namesMachines
        ? shown.executors.map((row) => ({ executorId: row.executor.id, label: row.executor.label }))
        : null,
      limits: terms.success ? {
        dailyUsd: terms.data.limits.dailyUsd,
        ticketHours: terms.data.limits.ticketHours,
        ticketUsd: terms.data.limits.ticketUsd,
      } : null,
      allowAnyCommand: profile.success ? profile.data.allowAnyCommand : null,
      viewerCanEnd: status !== 'ended' && (viewerIsAuthor || administered.size > 0),
    } : null,
    pendingCard: binding && preparing ? { createdAt: preparing.createdAt.toISOString(), policyId: preparing.id } : null,
    cardLocation: await cardLocationOf(prisma, preparing?.id ?? null),
    tickets: records.map((record) => {
      const reason = TicketWorkStateReasonSchema.safeParse(record.stateReason)
      const label = record.executorId ? labels.get(record.executorId) : undefined
      return {
        workId: record.id,
        taskId: record.taskId,
        projectId: record.projectId,
        title: ticketWorkThreadTitle(record.task),
        status: TicketWorkStatusSchema.parse(record.status),
        stateReason: reason.success ? reason.data : null,
        position: record.status === 'queued' ? record.queuePosition : null,
        machineLabel: namesMachines && label ? label : null,
      }
    }),
  }
}

/**
 * The private machines the author paired in this organisation, each with the
 * refusal it has whatever they choose, and the facts the setup form checks as
 * they change the bypass tick, `ticketUsd` or the roots. Assessed as the most
 * permissive choice would be, so that only what no option can fix is refused
 * here; prepare checks the real choice again.
 */
export const listStandingPolicyMachineOptions = async (
  prisma: PrismaClient,
  input: { authorUserId: string; organizationId: string },
): Promise<StandingPolicyMachineOption[]> => {
  const executors = await prisma.executor.findMany({
    where: {
      organizationId: input.organizationId, pairingOwnerUserId: input.authorUserId, removedAt: null, scopeKind: 'private',
    },
    orderBy: { label: 'asc' },
    take: 50,
    select: { id: true, label: true },
  })
  const options: StandingPolicyMachineOption[] = []
  for (const executor of executors) {
    const assessed = await assessStandingPolicyMachine(prisma, {
      allowAnyCommand: true,
      allowedRootNames: null,
      authorUserId: input.authorUserId,
      executorId: executor.id,
      organizationId: input.organizationId,
      requireOnline: true,
      ticketUsd: STANDING_POLICY_LIMIT_CEILINGS.ticketUsd,
    })
    const facts = assessed.ok ? assessed.facts : await reviewedFactsOf(prisma, executor.id)
    options.push({
      executorId: executor.id,
      label: executor.label,
      refusal: assessed.ok ? null : { reason: assessed.reason, sentence: assessed.sentence },
      facts: facts ? {
        maxLiveSessionsPerOwner: facts.maxLiveSessionsPerOwner ?? null,
        mergeCommands: facts.mergeCommands ?? [],
        permissionMode: facts.permissionMode.claude ?? 'default',
        rootNames: facts.rootNames,
        turnBudgetUsd: facts.maxBudgetUsd?.claude ?? null,
        unaskedCommands: facts.unaskedCommands ?? null,
      } : null,
    })
  }
  return options
}

/** The coding facts of a machine's live revision, for one the assessment refused. */
const reviewedFactsOf = async (prisma: PrismaClient, executorId: string) => {
  const latest = await prisma.executorCapabilityRevision.findFirst({
    where: { executorId }, orderBy: { revision: 'desc' }, select: { descriptor: true, reviewStatus: true },
  })
  const descriptor = latest?.reviewStatus === 'active'
    ? ExecutorCapabilityDescriptorSchema.safeParse(latest.descriptor)
    : null
  return descriptor?.success && offersReviewedCodingSessions(descriptor.data)
    ? descriptor.data.codingSessions ?? null
    : null
}
