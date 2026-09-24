import type { Prisma } from '@prisma/client'
import {
  executorCodingSessionOwnerKey,
  loadTicketWorkLimitState,
  reportedExecutorCodingSessions,
  type TicketWorkLimitState,
} from '@nessie/executor-manage'
import { ticketWorkCodingSessionContext } from '@nessie/schemas'

/**
 * The machine half of every kickoff's state block
 * (docs/plans/2026-09-23-ticket-driven-agents/ticket-work.md → "What every
 * wake says"): where the work stands with its machine, its hours and spend
 * against its policy's limits, the ticket's own coding session as the machine
 * last reported it, and the pull request on record. Read afresh from the
 * record every time the kickoff is rendered. Nothing here names the machine:
 * the work thread is the project's to read.
 */

export type TicketWorkMachineFacts = {
  limits: TicketWorkLimitState | null
  policy: 'live' | 'suspended' | null
  pullRequest: {
    checks: { failed: number; passed: number; pending: number } | null
    seenAt: Date | null
    state: string | null
    url: string
  } | null
  queuePosition: number | null
  /** The sessions this ticket's own owner holds on its machine, as last reported; null when nothing can be said. */
  sessions: Array<{ sessionId: string; status: string; turn: number | null }> | null
  stateReason: string | null
  status: string
  pinned: boolean
}

const checksOf = (value: unknown): { failed: number; passed: number; pending: number } | null => {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  const count = (key: string): number => (typeof record?.[key] === 'number' ? record[key] as number : 0)
  return record ? { failed: count('failed'), passed: count('passed'), pending: count('pending') } : null
}

export const loadTicketWorkMachineFacts = async (
  prisma: Prisma.TransactionClient,
  input: { workId: string },
): Promise<TicketWorkMachineFacts> => {
  const work = await prisma.agentTicketWork.findUniqueOrThrow({
    where: { id: input.workId },
    select: {
      agentId: true, executorId: true, lastChecks: true, lastPrState: true, policyId: true, prSeenAt: true,
      pullRequestUrl: true, queuePosition: true, sessionIds: true, stateReason: true, status: true, taskId: true,
      executor: { select: { localMcp: true } },
      policy: { select: { authorUserId: true, status: true } },
    },
  })
  const policyStatus = work.policy?.status === 'live' || work.policy?.status === 'suspended' ? work.policy.status : null
  const sessions = work.executorId && work.policyId && work.policy
    ? (() => {
        const ownerKey = executorCodingSessionOwnerKey(work.executorId, {
          actorUserId: work.policy.authorUserId,
          agentId: work.agentId,
          contextId: ticketWorkCodingSessionContext(work.policyId, work.taskId),
        })
        return reportedExecutorCodingSessions(work.executor?.localMcp)
          .filter((session) => session.ownerKey === ownerKey && session.status !== 'closed')
          .map((session) => ({ sessionId: session.sessionId, status: session.status, turn: session.turn ?? null }))
      })()
    : null
  return {
    limits: await loadTicketWorkLimitState(prisma, { workId: input.workId }),
    pinned: work.executorId !== null,
    policy: policyStatus,
    pullRequest: work.pullRequestUrl
      ? { checks: checksOf(work.lastChecks), seenAt: work.prSeenAt, state: work.lastPrState, url: work.pullRequestUrl }
      : null,
    queuePosition: work.queuePosition,
    sessions,
    stateReason: work.stateReason,
    status: work.status,
  }
}

const hoursAndMinutes = (ms: number): string => {
  const minutes = Math.floor(ms / 60_000)
  const hours = Math.floor(minutes / 60)
  return hours > 0 ? `${hours} h ${minutes % 60} min` : `${minutes} min`
}

const dollars = (amount: number): string => `$${amount.toFixed(2).replace(/\.00$/, '')}`

const clock = (at: Date): string => `${at.toISOString().slice(11, 16)} UTC`

/** "1 h 12 min of 4 h, coding cost $3.10 of $20 (as last seen)", when a policy's limits apply. */
export const ticketWorkLimitsClause = (facts: TicketWorkMachineFacts): string | null => facts.limits
  ? `${hoursAndMinutes(facts.limits.activeMs)} of ${facts.limits.limits.ticketHours} h, coding cost `
    + `${dollars(facts.limits.costUsd)} of ${dollars(facts.limits.limits.ticketUsd)} (as last seen)`
  : null

const machineLine = (facts: TicketWorkMachineFacts, ended: boolean): string => {
  if (ended) return 'Machine: none.'
  if (facts.status === 'queued') {
    return `Machine: none yet — the work is queued${facts.queuePosition ? ` at position ${facts.queuePosition}` : ''}, `
      + `because ${facts.stateReason === 'queued_machines_offline' ? 'the machines are offline' : 'every machine is busy'}; `
      + 'you will be woken here when one frees.'
  }
  if (facts.status === 'waiting_machine' && facts.stateReason === 'machine_offline') {
    return 'Machine: its machine is offline; the work resumes, and you are woken, when it reconnects.'
  }
  if (facts.status === 'parked') return 'Machine: none while the work is parked; its coding session stays open.'
  if (facts.status === 'active' && facts.pinned && facts.policy === 'live') {
    return 'Machine: one of its owner\'s machines is assigned to this work. Whether it is bound for this run, and what '
      + 'you can do on it, is in this run\'s machine facts. Never name the machine on the ticket or in this thread.'
  }
  if (facts.policy === 'suspended' || facts.stateReason === 'machine_access_suspended') {
    return 'Machine: none — machine access for this trigger is paused until the machines\' owner confirms it again, so '
      + 'no coding agent can work this ticket now: read it, comment on it and move it.'
  }
  return 'Machine: none — machine access for this trigger is not set up, so no coding agent can work this ticket: '
    + 'read it, comment on it and move it.'
}

const sessionLine = (facts: TicketWorkMachineFacts): string | null => {
  if (facts.status !== 'active' || !facts.pinned || facts.sessions === null) return null
  if (facts.sessions.length === 0) return 'Coding session for this ticket: none open yet.'
  const listed = facts.sessions.map((session) => (
    `${session.sessionId} ${session.status}${session.turn === null ? '' : `, turn ${session.turn}`}`))
  return `Coding session${facts.sessions.length === 1 ? '' : 's'} for this ticket: ${listed.join('; ')}; no other `
    + 'session belongs to this ticket.'
}

/** "Pull request: <url>, MERGED, checks 14 passed (15:20 UTC)." */
export const pullRequestLine = (facts: TicketWorkMachineFacts): string => {
  const pr = facts.pullRequest
  if (!pr) return 'Pull request: none on record.'
  const checks = pr.checks
    ? pr.checks.failed === 0 && pr.checks.pending === 0
      ? `checks ${pr.checks.passed} passed`
      : `checks ${pr.checks.passed} passed / ${pr.checks.failed} failed / ${pr.checks.pending} pending`
    : null
  return `Pull request: ${[pr.url, pr.state, checks].filter(Boolean).join(', ')}${pr.seenAt ? ` (${clock(pr.seenAt)})` : ''}.`
}

export const ticketWorkMachineLines = (facts: TicketWorkMachineFacts, ended: boolean): string[] => [
  machineLine(facts, ended),
  ...(ended ? [] : [sessionLine(facts)].filter((line): line is string => line !== null)),
  pullRequestLine(facts),
]
