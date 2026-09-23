import type { Prisma } from '@prisma/client'
import {
  EXECUTOR_CODING_SESSION_CLOSE_MAXIMUM,
  EXECUTOR_CODING_SESSION_REPORT_MAXIMUM,
  EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME,
  ExecutorLocalMcpReportSchema,
  type ExecutorCodingSessionCloseReason,
  type ExecutorLocalMcpReport,
} from '@nessie/schemas'

import {
  executorCodingSessionOwnerKey,
  executorCodingSessionsAllowed,
  type ExecutorCodingSessionOwner,
} from './executor-coding-session-owner.js'
import { EXECUTOR_HEARTBEAT_FRESHNESS_MS } from './executor-liveness.js'

/**
 * The control plane's half of coding-session teardown
 * (docs/executor-protocol/host-coding-sessions.md → "Teardown reaches the
 * machine"). Sessions outlive runs, so when an owner's authority to drive
 * them ends — their last lease on the machine, the agent's access, the
 * machine itself — a close request is written in the transaction that ends
 * it, and every heartbeat answers with the executor's unresolved requests as
 * `codingSessionClose` until a local-MCP report taken after the request no
 * longer lists what it names, or for a day at most.
 *
 * Only a private executor's pairing owner can ever have driven the bridge
 * (`executorCodingSessionsAllowed`), so that is the only person an owner key
 * is derived for.
 */

export const EXECUTOR_CODING_SESSION_CLOSE_TTL_MS = 24 * 60 * 60 * 1_000

type CloseEntry = {
  ownerKey: string
  reason: ExecutorCodingSessionCloseReason
  requestedByUserId: string | null
  sessionId?: string
}

/** A second open request for the same owner (or session) is dropped by the table's partial unique indexes. */
const writeCloseRequests = async (
  tx: Prisma.TransactionClient,
  executorId: string,
  entries: readonly CloseEntry[],
): Promise<void> => {
  if (entries.length === 0) return
  await tx.executorCodingSessionCloseRequest.createMany({
    data: entries.map((entry) => ({
      executorId,
      ownerKey: entry.ownerKey,
      reason: entry.reason,
      requestedByUserId: entry.requestedByUserId,
      sessionId: entry.sessionId ?? null,
    })),
    skipDuplicates: true,
  })
}

/**
 * Close these owners' sessions, each for its own reason. An owner who cannot
 * have driven the bridge — anyone on a shared executor, anyone but its pairing
 * owner on a private one — has none, and gets no request.
 */
export const requestExecutorCodingSessionClosesInTransaction = async (
  tx: Prisma.TransactionClient,
  executorId: string,
  closes: ReadonlyArray<{
    owner: ExecutorCodingSessionOwner
    reason: ExecutorCodingSessionCloseReason
    requestedByUserId: string | null
  }>,
): Promise<void> => {
  if (closes.length === 0) return
  const executor = await tx.executor.findUnique({
    where: { id: executorId },
    select: { pairingOwnerUserId: true, scopeKind: true },
  })
  if (!executor) return
  await writeCloseRequests(tx, executorId, closes
    .filter((close) => executorCodingSessionsAllowed(executor, close.owner.actorUserId))
    .map((close) => ({
      ownerKey: executorCodingSessionOwnerKey(executorId, close.owner),
      reason: close.reason,
      requestedByUserId: close.requestedByUserId,
    })))
}

const reportedCodingSessions = (stored: unknown) => {
  const report = ExecutorLocalMcpReportSchema.safeParse(stored)
  if (!report.success) return []
  return report.data.find((status) => status.server === EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME)?.codingSessions ?? []
}

/**
 * Close the coding sessions a withdrawal reaches: one agent's (its access to
 * the machine), the pairing owner's (their place on its roster), or every
 * session on the machine (it was paused or revoked). The agents are those the
 * owner ever bound the local-apps pair for here; a machine-wide close also
 * names every owner its last report listed, which covers a session whose
 * binding went with its run.
 */
export const closeExecutorCodingSessionsInTransaction = async (
  tx: Prisma.TransactionClient,
  input: {
    executorId: string
    reason: ExecutorCodingSessionCloseReason
    requestedByUserId: string | null
    only?: { agentId: string } | { actorUserId: string }
  },
): Promise<void> => {
  const executor = await tx.executor.findUnique({
    where: { id: input.executorId },
    select: { localMcp: true, pairingOwnerUserId: true, scopeKind: true },
  })
  if (!executor || executor.scopeKind !== 'private') return
  const actorUserId = executor.pairingOwnerUserId
  if (input.only && 'actorUserId' in input.only && input.only.actorUserId !== actorUserId) return
  const agentIds = input.only && 'agentId' in input.only
    ? [input.only.agentId]
    : (await tx.executorAvailabilityCandidate.findMany({
        where: {
          actorUserId, consumedAt: { not: null }, executorId: input.executorId, operationKeys: { has: 'mcp.call' },
        },
        distinct: ['agentId'],
        select: { agentId: true },
      })).map((candidate) => candidate.agentId)
  const ownerKeys = new Set(agentIds.map((agentId) => (
    executorCodingSessionOwnerKey(input.executorId, { actorUserId, agentId })
  )))
  if (!input.only || 'actorUserId' in input.only) {
    for (const session of reportedCodingSessions(executor.localMcp)) ownerKeys.add(session.ownerKey)
  }
  await writeCloseRequests(tx, input.executorId, [...ownerKeys].map((ownerKey) => ({
    ownerKey, reason: input.reason, requestedByUserId: input.requestedByUserId,
  })))
}

/**
 * A new lease for an owner withdraws that owner's open machine-wide requests:
 * the person may drive those sessions again, and a close still waiting for a
 * heartbeat would end what their new run starts. A person's Close on one
 * session stands.
 */
export const withdrawExecutorCodingSessionClosesInTransaction = async (
  tx: Prisma.TransactionClient,
  input: { executorId: string; now: Date; owner: ExecutorCodingSessionOwner },
): Promise<void> => {
  await tx.executorCodingSessionCloseRequest.updateMany({
    where: {
      executorId: input.executorId,
      ownerKey: executorCodingSessionOwnerKey(input.executorId, input.owner),
      resolvedAt: null,
      sessionId: null,
    },
    data: { resolvedAt: input.now },
  })
}

type OpenRequest = { createdAt: Date; ownerKey: string; sessionId: string | null }

/**
 * Whether a report shows a request done. A daemon that fronts no bridge has
 * nothing to close. Otherwise only a look at the sessions taken after the
 * request was made counts — the margin is the clock difference a heartbeat is
 * allowed — and a list cut at its maximum proves nothing by what it leaves out.
 */
const reportShowsDone = (report: ExecutorLocalMcpReport, request: OpenRequest): boolean => {
  const bridge = report.find((status) => status.server === EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME)
  if (!bridge) return true
  const sessions = bridge.codingSessions
  if (!sessions || sessions.length >= EXECUTOR_CODING_SESSION_REPORT_MAXIMUM) return false
  const observedAt = new Date(bridge.observedAt).getTime()
  if (observedAt - EXECUTOR_HEARTBEAT_FRESHNESS_MS <= request.createdAt.getTime()) return false
  return !sessions.some((session) => (
    session.status !== 'closed'
    && session.ownerKey === request.ownerKey
    && (request.sessionId === null || session.sessionId === request.sessionId)
  ))
}

/**
 * The heartbeat's half, inside its transaction: settle what the report it
 * carried shows done and what has waited a day, then answer with the rest,
 * oldest first. A heartbeat without a report settles nothing by report.
 */
export const takeExecutorCodingSessionClosesInTransaction = async (
  tx: Prisma.TransactionClient,
  input: { executorId: string; localMcp?: ExecutorLocalMcpReport; now: Date },
): Promise<Array<{ ownerKey: string; reason: string; sessionId?: string }>> => {
  await tx.executorCodingSessionCloseRequest.updateMany({
    where: {
      createdAt: { lte: new Date(input.now.getTime() - EXECUTOR_CODING_SESSION_CLOSE_TTL_MS) },
      executorId: input.executorId,
      resolvedAt: null,
    },
    data: { resolvedAt: input.now },
  })
  const open = await tx.executorCodingSessionCloseRequest.findMany({
    where: { executorId: input.executorId, resolvedAt: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { createdAt: true, id: true, ownerKey: true, reason: true, sessionId: true },
  })
  const report = input.localMcp
  const done = new Set(report
    ? open.filter((request) => reportShowsDone(report, request)).map((request) => request.id)
    : [])
  if (done.size > 0) {
    await tx.executorCodingSessionCloseRequest.updateMany({
      where: { id: { in: [...done] }, resolvedAt: null },
      data: { resolvedAt: input.now },
    })
  }
  return open
    .filter((request) => !done.has(request.id))
    .slice(0, EXECUTOR_CODING_SESSION_CLOSE_MAXIMUM)
    .map((request) => ({
      ownerKey: request.ownerKey,
      reason: request.reason,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    }))
}
