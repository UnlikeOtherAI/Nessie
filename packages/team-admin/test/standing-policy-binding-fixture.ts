import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'
import { bindStandingPolicyExecutor, reportExecutorHeartbeat } from '@nessie/executor-manage'
import {
  AuthorizedActionContextSchema,
  canonicalExecutorPayload,
  TICKET_WORK_PURPOSE,
  type ExecutorLocalMcpReport,
  type RunExecuteJobPayload,
} from '@nessie/schemas'

import { canMemberEditProjectBoards } from '../src/resource-authority.js'
import { ticketInWorkFlow } from '../src/ticket-work-lock.js'
import type { StandingPolicyWorld } from './standing-policy-fixture.js'

/**
 * A ticket's work as the binder meets it: a confirmed policy on the world's
 * machines, a record the pool gave one of them, and one `ticket.work` wake of
 * it — the kickoff in its thread, the run, and the job run setup is handed.
 */

export const confirmPolicy = async (world: StandingPolicyWorld, executorIds: string[]): Promise<string> => {
  const prepared = await world.prepare({ executorIds })
  await world.confirm(prepared)
  return prepared.policyId
}

/** The author stands in a team of the project, as a signed-in session does. */
export const seatAuthor = (prisma: PrismaClient, world: StandingPolicyWorld) =>
  prisma.teamMember.create({ data: { role: 'member', teamId: world.teamId, userId: world.authorId } })

export type Wake = { job: RunExecuteJobPayload; kickoffId: string; runId: string }

/** One wake of the record: its kickoff, its run, and the job that names both. */
export const wakeRun = async (
  prisma: PrismaClient,
  world: StandingPolicyWorld,
  work: { id: string; threadId: string },
  options: { batchMessageIds?: string[]; kickoffFor?: string } = {},
): Promise<Wake> => {
  const kickoff = await prisma.message.create({
    data: {
      content: 'Why you were woken…',
      metadata: {
        ticketWorkKickoff: {
          events: [{ at: new Date().toISOString(), reason: 'pickup', text: 'Colleague moved the ticket.' }],
          workId: options.kickoffFor ?? work.id,
        },
      },
      role: 'system',
      threadId: work.threadId,
    },
  })
  const run = await prisma.run.create({
    data: { agentId: world.agentId, status: 'running', threadId: work.threadId, triggerMessageId: kickoff.id },
  })
  const job = {
    actorContext: AuthorizedActionContextSchema.parse({
      actionContext: { purpose: TICKET_WORK_PURPOSE, requestId: randomUUID(), ticketWorkId: work.id },
      actor: { actorId: world.agentId, actorType: 'agent' },
      tenant: { organizationId: world.organizationId },
    }),
    agentId: world.agentId,
    ...(options.batchMessageIds ? { batchMessageIds: [kickoff.id, ...options.batchMessageIds] } : {}),
    messageId: kickoff.id,
    runId: run.id,
    taskId: randomUUID(),
    threadId: work.threadId,
  } as RunExecuteJobPayload
  return { job, kickoffId: kickoff.id, runId: run.id }
}

export const bindWake = (prisma: PrismaClient, wake: Wake, workId: string) =>
  bindStandingPolicyExecutor(prisma, { job: wake.job, runId: wake.runId }, { workId }, {
    canEditBoard: (check) => canMemberEditProjectBoards(prisma, check),
    ticketInFlow: (check) => ticketInWorkFlow(prisma, check),
    // A local organisation, whatever UOA settings another suite in this process left behind.
    entitlements: { settings: null, uoaConfigured: false },
  })

/** Everything a bind leaves that the world's own cleanup would trip over. */
export const clearBindings = async (prisma: PrismaClient, world: StandingPolicyWorld): Promise<void> => {
  const bindings = await prisma.executorBinding.findMany({
    where: { run: { thread: { channel: { organizationId: world.organizationId } } } },
    select: { id: true },
  })
  await prisma.executorCommand.deleteMany({ where: { bindingId: { in: bindings.map((binding) => binding.id) } } })
  await prisma.executorBinding.deleteMany({ where: { id: { in: bindings.map((binding) => binding.id) } } })
}

/** A machine's daemon key, for the heartbeats the tests sign. */
export const pairKey = async (prisma: PrismaClient, executorId: string): Promise<KeyObject> => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')
  await prisma.executor.update({ where: { id: executorId }, data: { machinePublicKey: raw } })
  return privateKey
}

export const heartbeat = async (
  prisma: PrismaClient,
  input: { executorId: string; key: KeyObject; localMcp?: ExecutorLocalMcpReport; now?: Date },
) => {
  const now = input.now ?? new Date()
  const executor = await prisma.executor.findUniqueOrThrow({
    where: { id: input.executorId }, select: { activeConnectionEpoch: true },
  })
  const payload = {
    connectionEpoch: executor.activeConnectionEpoch.toString(),
    executorId: input.executorId,
    ...(input.localMcp ? { localMcp: input.localMcp } : {}),
    observedAt: now.toISOString(),
  }
  const signature = sign(
    null, Buffer.from(canonicalExecutorPayload('nessie.executor.daemon.heartbeat.v1', payload)), input.key,
  ).toString('base64url')
  return reportExecutorHeartbeat(prisma, { ...payload, signature }, now)
}

/** The coding bridge's report, listing these sessions under this owner key. */
export const bridgeReport = (
  sessions: Array<{
    ownerKey: string
    reason?: string
    sessionId: string
    status?: string
    title?: string
    totalCostUsd?: number
    turn?: number
  }>,
  observedAt = new Date(),
): ExecutorLocalMcpReport => [{
  available: true,
  codingSessions: sessions.map((session) => ({
    agent: 'claude', ownerKey: session.ownerKey, root: 'nessie', sessionId: session.sessionId,
    status: session.status ?? 'working', title: session.title ?? 'Fix login redirect', updatedAt: observedAt.toISOString(),
    ...(session.reason ? { reason: session.reason } : {}),
    ...(session.turn === undefined ? {} : { lastTurnEndedAt: null, turn: session.turn }),
    ...(session.totalCostUsd === undefined ? {} : { totalCostUsd: session.totalCostUsd }),
  })),
  observedAt: observedAt.toISOString(),
  server: 'coding-sessions',
}] as ExecutorLocalMcpReport
