import { Prisma, type PrismaClient } from '@prisma/client'
import { TicketWorkPullRequestStateSchema } from '@nessie/schemas'

import { addTicketWorkCostInTransaction } from './executor-standing-policy-limits.js'
import { ticketWorkSessionOriginEntry } from './ticket-work-session-origins.js'

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
 *   session wake at or below it is skipped (T5);
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

export const recordTicketWorkSessionObservation = async (
  prisma: Client,
  input: { now?: Date; sessionId: string; status?: string; totalCostUsd?: number; turn?: number; workId: string },
): Promise<void> => {
  await prisma.$transaction(async (tx) => {
    await lockWork(tx, input.workId)
    const work = await tx.agentTicketWork.findUnique({
      where: { id: input.workId }, select: { lastObservedTurn: true, sessionCosts: true, sessionIds: true },
    })
    if (!work || !work.sessionIds.includes(input.sessionId)) return
    const costs = numberMap(work.sessionCosts)
    const turns = numberMap(work.lastObservedTurn)
    const data: Prisma.AgentTicketWorkUpdateInput = {}
    let delta = 0
    if (typeof input.totalCostUsd === 'number' && input.totalCostUsd > (costs[input.sessionId] ?? 0)) {
      delta = input.totalCostUsd - (costs[input.sessionId] ?? 0)
      data.sessionCosts = { ...costs, [input.sessionId]: input.totalCostUsd }
    }
    if (typeof input.turn === 'number' && input.status && TURN_ENDED.has(input.status)
      && input.turn > (turns[input.sessionId] ?? 0)) {
      data.lastObservedTurn = { ...turns, [input.sessionId]: input.turn }
    }
    if (Object.keys(data).length > 0) await tx.agentTicketWork.update({ where: { id: input.workId }, data })
    await addTicketWorkCostInTransaction(tx, { deltaUsd: delta, now: input.now, workId: input.workId })
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
