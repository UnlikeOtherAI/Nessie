import type { Prisma, PrismaClient } from '@prisma/client'
import { writeAuditEntryInTransaction } from '@nessie/db'
import {
  EXECUTOR_CODING_SESSION_CLOSE_MAXIMUM,
  EXECUTOR_CODING_SESSION_REPORT_MAXIMUM,
  EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME,
  ExecutorLocalMcpReportSchema,
  type AuthorizedActionContext,
  type ExecutorCodingSessionCloseReason,
  type ExecutorCodingSessionSummary,
  type ExecutorLocalMcpReport,
} from '@nessie/schemas'

import { requireHumanActor } from './executor-access.js'
import {
  executorCodingSessionOwnerKey,
  executorCodingSessionsAllowed,
  reviewedCodingSessionsServer,
  type ExecutorCodingSessionOwner,
} from './executor-coding-session-owner.js'
import { EXECUTOR_ERROR_CODES, ExecutorError } from './executor-errors.js'
import { EXECUTOR_HEARTBEAT_FRESHNESS_MS } from './executor-liveness.js'
import { getExecutorForManagement } from './executor-records.js'

/**
 * The control plane's half of coding-session teardown
 * (docs/executor-protocol/host-coding-sessions-containment.md → "Teardown reaches the
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
 * Whether the machine can hold coding sessions at all: a revision of it ever
 * offered the bridge, or its last report lists the bridge. A machine with
 * neither has no bridge a close could reach, and a request would only ride
 * every heartbeat for its whole day.
 */
const executorMayHoldCodingSessions = async (
  tx: Prisma.TransactionClient,
  executorId: string,
  localMcp: unknown,
): Promise<boolean> => {
  const report = ExecutorLocalMcpReportSchema.safeParse(localMcp)
  if (report.success && report.data.some((status) => status.server === EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME)) {
    return true
  }
  const revisions = await tx.executorCapabilityRevision.findMany({
    where: { executorId },
    select: { descriptor: true },
  })
  return revisions.some((revision) => reviewedCodingSessionsServer(revision.descriptor) !== null)
}

/**
 * Close these owners' sessions, each for its own reason. An owner who cannot
 * have driven the bridge — anyone on a shared executor, anyone but its pairing
 * owner on a private one — has none, and gets no request; nor does anyone on
 * a machine that never offered the bridge.
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
    select: { localMcp: true, pairingOwnerUserId: true, scopeKind: true },
  })
  if (!executor) return
  const allowed = closes.filter((close) => executorCodingSessionsAllowed(executor, close.owner.actorUserId))
  if (allowed.length === 0 || !await executorMayHoldCodingSessions(tx, executorId, executor.localMcp)) return
  await writeCloseRequests(tx, executorId, allowed.map((close) => ({
    ownerKey: executorCodingSessionOwnerKey(executorId, close.owner),
    reason: close.reason,
    requestedByUserId: close.requestedByUserId,
  })))
}

/**
 * Close named sessions of one owner: one ticket's work under a standing
 * policy, whose sessions the platform closes by id when the ticket leaves its
 * flow, the trigger changes, the policy is suspended or ends, or a limit is
 * hit (docs/standards/ticket-work.md → "Teardown, limits and session closes
 * are the platform's"). The owner key carries the ticket's context, so no
 * other session of the author's is named. The same rules as every close: only
 * the pairing owner of a private machine can have driven the bridge, and a
 * machine that never offered it gets nothing.
 */
export const requestExecutorCodingSessionCloseForSessionsInTransaction = async (
  tx: Prisma.TransactionClient,
  input: {
    executorId: string
    owner: ExecutorCodingSessionOwner
    reason: ExecutorCodingSessionCloseReason
    requestedByUserId: string | null
    sessionIds: readonly string[]
  },
): Promise<void> => {
  if (input.sessionIds.length === 0) return
  const executor = await tx.executor.findUnique({
    where: { id: input.executorId },
    select: { localMcp: true, pairingOwnerUserId: true, scopeKind: true },
  })
  if (!executor || !executorCodingSessionsAllowed(executor, input.owner.actorUserId)) return
  if (!await executorMayHoldCodingSessions(tx, input.executorId, executor.localMcp)) return
  const ownerKey = executorCodingSessionOwnerKey(input.executorId, input.owner)
  await writeCloseRequests(tx, input.executorId, [...new Set(input.sessionIds)].map((sessionId) => ({
    ownerKey, reason: input.reason, requestedByUserId: input.requestedByUserId, sessionId,
  })))
}

/**
 * The sessions the machine's stored local-MCP report lists for its bridge,
 * or none when it lists none, has not asked the bridge, or cannot be read.
 */
export const reportedExecutorCodingSessions = (stored: unknown): ExecutorCodingSessionSummary[] => {
  const report = ExecutorLocalMcpReportSchema.safeParse(stored)
  if (!report.success) return []
  return report.data.find((status) => status.server === EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME)?.codingSessions ?? []
}

/**
 * The agents a person could own sessions for on this machine: those they ever
 * bound the local-apps pair for here. A consumed candidate is a binding's
 * durable provenance and is never swept, so the list does not shrink as runs
 * end. Only the pairing owner of a private executor can ever have driven the
 * bridge, which is the only person a caller should ask about.
 */
export const executorCodingSessionOwnerAgentIds = async (
  client: Prisma.TransactionClient | Pick<PrismaClient, 'executorAvailabilityCandidate'>,
  executorId: string,
  actorUserId: string,
): Promise<string[]> => (await client.executorAvailabilityCandidate.findMany({
  where: { actorUserId, consumedAt: { not: null }, executorId, operationKeys: { has: 'mcp.call' } },
  distinct: ['agentId'],
  select: { agentId: true },
})).map((candidate) => candidate.agentId)

/**
 * Close the coding sessions a withdrawal reaches: one agent's (its access to
 * the machine), the pairing owner's (their place on its roster), or every
 * session on the machine (it was paused or revoked). The agents are those the
 * owner ever bound the local-apps pair for here; a machine-wide close also
 * names every owner its last report listed, which covers a session whose
 * binding went with its run. A machine that never offered the bridge gets
 * none.
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
  if (!await executorMayHoldCodingSessions(tx, input.executorId, executor.localMcp)) return
  const agentIds = input.only && 'agentId' in input.only
    ? [input.only.agentId]
    : await executorCodingSessionOwnerAgentIds(tx, input.executorId, actorUserId)
  const ownerKeys = new Set(agentIds.map((agentId) => (
    executorCodingSessionOwnerKey(input.executorId, { actorUserId, agentId })
  )))
  if (!input.only || 'actorUserId' in input.only) {
    for (const session of reportedExecutorCodingSessions(executor.localMcp)) ownerKeys.add(session.ownerKey)
  }
  await writeCloseRequests(tx, input.executorId, [...ownerKeys].map((ownerKey) => ({
    ownerKey, reason: input.reason, requestedByUserId: input.requestedByUserId,
  })))
}

/**
 * A new lease for an owner withdraws that owner's open request for an ended
 * lease — the one the lease it replaces asked for a moment ago: the person may
 * drive those sessions again, and a close still waiting for a heartbeat would
 * end what their new run starts. Nothing else is withdrawn: a revoked access
 * or a paused or revoked machine ended the authority those sessions ran
 * under, and a person's Close on one session stands.
 */
export const withdrawExecutorCodingSessionClosesInTransaction = async (
  tx: Prisma.TransactionClient,
  input: { executorId: string; now: Date; owner: ExecutorCodingSessionOwner },
): Promise<void> => {
  await tx.executorCodingSessionCloseRequest.updateMany({
    where: {
      executorId: input.executorId,
      ownerKey: executorCodingSessionOwnerKey(input.executorId, input.owner),
      reason: 'lease_ended',
      resolvedAt: null,
      sessionId: null,
    },
    data: { resolvedAt: input.now },
  })
}

/**
 * A person's Close on one session, from the executor page. Only the person
 * who paired a private machine may ask — every session on it acts as them,
 * and a shared machine runs none (`executorCodingSessionsAllowed`) — and
 * only for a session its last report lists under that owner key, so no
 * request names a session that is not there. Asking again while one is open
 * adds nothing (the per-session partial unique index) and answers the same;
 * a new lease never withdraws it. Anyone who may not manage the machine is
 * told it does not exist, as every other management call tells them.
 */
export const requestExecutorCodingSessionClose = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: { executorId: string; ownerKey: string; sessionId: string },
): Promise<{ created: boolean }> => {
  const actorUserId = requireHumanActor(actorContext)
  const managed = actorUserId ? await getExecutorForManagement(prisma, actorContext, input.executorId) : null
  if (!managed || !actorUserId) throw new ExecutorError(EXECUTOR_ERROR_CODES.NOT_FOUND, 'Executor not found.')
  return prisma.$transaction(async (tx) => {
    const executor = await tx.executor.findUniqueOrThrow({
      where: { id: input.executorId },
      select: { localMcp: true, organizationId: true, pairingOwnerUserId: true, scopeKind: true },
    })
    if (!executorCodingSessionsAllowed(executor, actorUserId)) {
      throw new ExecutorError(
        EXECUTOR_ERROR_CODES.CODING_SESSIONS_OWNER_ONLY,
        executor.scopeKind === 'private'
          ? 'Coding sessions on this machine act as the person who paired it, so only they can close one.'
          : 'Coding sessions run only on a private executor, as the person who paired it; this executor is shared.',
      )
    }
    const listed = reportedExecutorCodingSessions(executor.localMcp).some((session) => (
      session.status !== 'closed' && session.sessionId === input.sessionId && session.ownerKey === input.ownerKey
    ))
    if (!listed) {
      throw new ExecutorError(
        EXECUTOR_ERROR_CODES.CODING_SESSION_NOT_FOUND,
        'That coding session is no longer open on this machine.',
      )
    }
    const written = await tx.executorCodingSessionCloseRequest.createMany({
      data: [{
        executorId: input.executorId, ownerKey: input.ownerKey, reason: 'person',
        requestedByUserId: actorUserId, sessionId: input.sessionId,
      }],
      skipDuplicates: true,
    })
    if (written.count > 0) {
      await writeAuditEntryInTransaction(tx, {
        action: 'executor.coding_session.close_requested',
        actorId: actorUserId,
        actorType: 'user',
        metadata: { executorId: input.executorId, reason: 'person' },
        organizationId: executor.organizationId,
        outcome: 'success',
        requestId: actorContext.actionContext.requestId,
        resourceId: input.sessionId,
        resourceType: 'executor_coding_session',
      })
    }
    return { created: written.count > 0 }
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
