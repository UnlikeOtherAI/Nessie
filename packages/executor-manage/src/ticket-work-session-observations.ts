import { Prisma, type PrismaClient } from '@prisma/client'
import { lockThreadRunSlot } from '@nessie/db'
import { TicketWorkPullRequestStateSchema } from '@nessie/schemas'

import { addTicketWorkCostInTransaction } from './executor-standing-policy-limits.js'
import { ticketWorkSessionOriginEntry, ticketWorkSessionOriginsOf } from './ticket-work-session-origins.js'
import { forgetTicketWorkSessionsInTransaction } from './ticket-work-session-release.js'

/**
 * What a `ticket.work` run learns of its ticket's coding sessions, written
 * onto the work record as it learns it
 * (docs/plans/2026-09-23-ticket-driven-agents/machine-access.md → "Session
 * isolation", "Done means merged"; ticket-work.md → "Limits"):
 *
 * - the session a start returned, appended in the same step with its machine,
 *   its policy and when it started (`ticket-work-session-origins.ts`);
 * - what each status read and review saw it cost since the last one
 *   (`session_costs` keeps the newest cumulative total per session), and each
 *   Nessie run's own cost once (keyed `run:<runId>`), added to `costUsd` and
 *   to the policy's day;
 * - the newest turn end a wait or review saw (`lastObservedTurn`), so a
 *   turn-ended session wake at or below it is skipped (T5), and one still
 *   pending in the thread is withdrawn by the caller's `withdrawWakes`; both
 *   under the thread's run slot, the lock every wake is written under;
 * - a session the agent closed itself: it leaves the live set, and is kept
 *   under `lastObservedTurn.closed`, so its closing wakes nobody — even when
 *   its machine reported the close first and the heartbeat intake already let
 *   it go: its origin still names it the ticket's, and a closed wake that
 *   report already left pending in the thread is withdrawn;
 * - the pull request, the first time a review returns one, then its state and
 *   checks each time a review reads it — so a merged pull request whose branch
 *   the coding agent deleted is still on record, and still read by URL.
 */

type Client = PrismaClient

const numberMap = (value: Prisma.JsonValue | null | undefined): Record<string, number> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number'))
}

/** Lock the record for an update that reads what it then writes. */
const lockWork = (tx: Prisma.TransactionClient, workId: string) =>
  tx.$queryRaw(Prisma.sql`SELECT id FROM agent_ticket_work WHERE id = ${workId}::uuid FOR UPDATE`)

/**
 * A session this ticket started, onto its record once, with where and when it
 * started (`session_origins`): the machine it runs on and the policy whose
 * owner context it was started under.
 */
export const appendTicketWorkSession = async (
  prisma: Client,
  input: { executorId: string; now?: Date; policyId: string; sessionId: string; workId: string },
): Promise<void> => {
  const origin = JSON.stringify(ticketWorkSessionOriginEntry(input.sessionId, {
    executorId: input.executorId, policyId: input.policyId, startedAt: input.now ?? new Date(),
  }))
  await prisma.$executeRaw(Prisma.sql`
    UPDATE agent_ticket_work SET session_ids = array_append(session_ids, ${input.sessionId}),
      session_origins = session_origins || ${origin}::jsonb, updated_at = now()
    WHERE id = ${input.workId}::uuid AND NOT (${input.sessionId} = ANY(session_ids))`)
}

const TURN_ENDED = new Set(['waiting_for_input', 'interrupted', 'failed', 'closed'])

/** The sessions a record's agent closed itself, kept beside the turns it saw end. */
export const agentClosedTicketWorkSessions = (value: Prisma.JsonValue | null | undefined): string[] => {
  const closed = value && typeof value === 'object' && !Array.isArray(value) ? value.closed : undefined
  return Array.isArray(closed) ? closed.filter((id): id is string => typeof id === 'string') : []
}

/** A turn end the agent's own read saw, and whether it was the agent's own close of the session. */
export type ObservedSessionTurn = { closed?: boolean; sessionId: string; turn: number }

export const recordTicketWorkSessionObservation = async (
  prisma: Client,
  input: {
    /** The agent's own `coding_session_close` answered: the session leaves the live set. */
    closedByAgent?: boolean
    now?: Date
    sessionId: string
    status?: string
    totalCostUsd?: number
    turn?: number
    /**
     * Under the thread's run slot, once a turn end or the agent's own close is seen: withdraw the
     * wakes still pending for it.
     */
    withdrawWakes?: (
      tx: Prisma.TransactionClient,
      input: { agentId: string; seen: ObservedSessionTurn; threadId: string },
    ) => Promise<unknown>
    workId: string
  },
): Promise<void> => {
  const thread = await prisma.agentTicketWork.findUnique({
    where: { id: input.workId }, select: { agentId: true, threadId: true },
  })
  if (!thread) return
  await prisma.$transaction(async (tx) => {
    // The thread's run slot before the record, the order every wake takes them in.
    await lockThreadRunSlot(tx, { agentId: thread.agentId, threadId: thread.threadId })
    await lockWork(tx, input.workId)
    const work = await tx.agentTicketWork.findUnique({
      where: { id: input.workId },
      select: { lastObservedTurn: true, sessionCosts: true, sessionIds: true, sessionOrigins: true },
    })
    if (!work) return
    // The agent's own close of a session the heartbeat intake already let go — its machine reported
    // the close before this answer landed — is still this ticket's to record: its origin names it.
    const ownClose = input.closedByAgent === true
      && ticketWorkSessionOriginsOf(work.sessionOrigins)[input.sessionId] !== undefined
    if (!work.sessionIds.includes(input.sessionId) && !ownClose) return
    const costs = numberMap(work.sessionCosts)
    const turns = numberMap(work.lastObservedTurn)
    const closed = agentClosedTicketWorkSessions(work.lastObservedTurn)
    const data: Prisma.AgentTicketWorkUpdateInput = {}
    let delta = 0
    if (typeof input.totalCostUsd === 'number' && input.totalCostUsd > (costs[input.sessionId] ?? 0)) {
      delta = input.totalCostUsd - (costs[input.sessionId] ?? 0)
      data.sessionCosts = { ...costs, [input.sessionId]: input.totalCostUsd }
    }
    const turnEnded = typeof input.turn === 'number' && input.status !== undefined && TURN_ENDED.has(input.status)
    const seen = Math.max(turnEnded ? input.turn! : 0, turns[input.sessionId] ?? 0)
    if (seen > (turns[input.sessionId] ?? 0) || (input.closedByAgent && !closed.includes(input.sessionId))) {
      const closedNow = input.closedByAgent ? [...new Set([...closed, input.sessionId])] : closed
      data.lastObservedTurn = {
        ...turns,
        ...(turns[input.sessionId] !== undefined || turnEnded ? { [input.sessionId]: seen } : {}),
        ...(closedNow.length > 0 ? { closed: closedNow } : {}),
      }
    }
    if (Object.keys(data).length > 0) await tx.agentTicketWork.update({ where: { id: input.workId }, data })
    await addTicketWorkCostInTransaction(tx, { deltaUsd: delta, now: input.now, workId: input.workId })
    if (input.closedByAgent) {
      await forgetTicketWorkSessionsInTransaction(tx, { sessionIds: [input.sessionId], workId: input.workId })
    }
    if ((turnEnded || input.closedByAgent) && input.withdrawWakes) {
      await input.withdrawWakes(tx, {
        ...thread,
        seen: { sessionId: input.sessionId, turn: seen, ...(input.closedByAgent ? { closed: true } : {}) },
      })
    }
  })
}

/** A Nessie run's own cost, from the token ledger, added to its work once. */
export const recordTicketWorkRunCost = async (
  prisma: Client,
  input: { now?: Date; runId: string; workId: string },
): Promise<void> => {
  const spent = await prisma.tokenLedgerEvent.aggregate({
    where: { runId: input.runId },
    _sum: { estimatedCostAmount: true },
  })
  const amount = Number(spent._sum.estimatedCostAmount ?? 0)
  if (!(amount > 0)) return
  const key = `run:${input.runId}`
  await prisma.$transaction(async (tx) => {
    await lockWork(tx, input.workId)
    const work = await tx.agentTicketWork.findUnique({ where: { id: input.workId }, select: { sessionCosts: true } })
    const costs = numberMap(work?.sessionCosts)
    if (!work || costs[key] !== undefined) return
    await tx.agentTicketWork.update({
      where: { id: input.workId }, data: { sessionCosts: { ...costs, [key]: amount } },
    })
    await addTicketWorkCostInTransaction(tx, { deltaUsd: amount, now: input.now, workId: input.workId })
  })
}

const PASSED = new Set(['success', 'neutral', 'skipped'])
const FAILED = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'error', 'startup_failure', 'stale'])

/** `gh`'s check conclusions and states, counted the way the state block says them. */
export const pullRequestCheckCounts = (checks: unknown): { failed: number; passed: number; pending: number } => {
  const counts = { failed: 0, passed: 0, pending: 0 }
  if (!checks || typeof checks !== 'object' || Array.isArray(checks)) return counts
  for (const [key, value] of Object.entries(checks)) {
    if (typeof value !== 'number') continue
    if (PASSED.has(key)) counts.passed += value
    else if (FAILED.has(key)) counts.failed += value
    else counts.pending += value
  }
  return counts
}

export type ObservedPullRequest = { checks?: unknown; state?: unknown; url?: unknown }

const GITHUB_PULL_REQUEST = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/

/**
 * A review's pull requests, onto the record: the first one it ever returns is
 * the ticket's, and every later review of that URL updates its state, checks
 * and when they were seen.
 */
export const recordTicketWorkPullRequest = async (
  prisma: Client,
  input: { now?: Date; pullRequests: readonly ObservedPullRequest[]; workId: string },
): Promise<void> => {
  const seen = input.pullRequests.filter((entry): entry is ObservedPullRequest & { url: string } => (
    typeof entry.url === 'string' && GITHUB_PULL_REQUEST.test(entry.url)))
  if (seen.length === 0) return
  await prisma.$transaction(async (tx) => {
    await lockWork(tx, input.workId)
    const work = await tx.agentTicketWork.findUnique({ where: { id: input.workId }, select: { pullRequestUrl: true } })
    if (!work) return
    const pr = seen.find((entry) => entry.url === work.pullRequestUrl) ?? (work.pullRequestUrl ? null : seen[0])
    if (!pr) return
    const state = TicketWorkPullRequestStateSchema.safeParse(pr.state)
    await tx.agentTicketWork.update({
      where: { id: input.workId },
      data: {
        lastChecks: pullRequestCheckCounts(pr.checks),
        ...(state.success ? { lastPrState: state.data } : {}),
        prSeenAt: input.now ?? new Date(),
        pullRequestUrl: pr.url,
      },
    })
  })
}
