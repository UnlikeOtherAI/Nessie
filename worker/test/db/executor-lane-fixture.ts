import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import type { PrismaClient } from '@prisma/client'
import {
  bindExecutorCandidateBundleInTransaction,
  confirmExecutorAccessChange,
  ensureExecutorLogicalTools,
  pollExecutorCommand,
  prepareExecutorAccessChange,
  recordExecutorCommandReceipt,
  resolveExecutorAvailabilityCandidates,
} from '@nessie/executor-manage'
import {
  canonicalExecutorJson,
  ExecutorCapabilityDescriptorSchema,
  type AuthorizedActionContext,
} from '@nessie/schemas'

import type { CodingSessionsDaemon } from '../../../executor/src/coding-sessions-daemon.js'
import { executeExecutorMcpCommand } from '../../../executor/src/mcp-dispatch.js'
import type { ExecutorMcpSessionManager } from '../../../executor/src/mcp-session-manager.js'

/**
 * The control-plane half of the local-apps lane, shared by the suites that
 * drive it through real encrypted queued commands: a private executor whose
 * reviewed revision names its programs, the agent's confirmed grant, a
 * person's launch bound to one run, and a stand-in for the daemon that polls
 * the commands, runs the daemon's own `mcp.*` operation and posts receipts.
 */

export const LANE_SECRET = 'local-apps-lane-test-secret'

export const SCRIPTED_MCP_SERVER = fileURLToPath(
  new URL('../../../executor/test/fixtures/scripted-mcp-server.mjs', import.meta.url),
)

const digest = (value: unknown): string =>
  `sha256:${createHash('sha256').update(canonicalExecutorJson(value)).digest('hex')}`

/** The two logical tools the lane offers, granted in an agent's tool policy. */
export const localAppsToolPolicy = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<Record<string, boolean>> => {
  const tools = await ensureExecutorLogicalTools(prisma, organizationId)
  return { [tools.get('mcp.tools')!]: true, [tools.get('mcp.call')!]: true }
}

/**
 * A private executor, reviewed with `mcpServers` (and the coding bridge's power
 * facts when given), whose owner — the person who paired it — granted it to the agent.
 */
export const seedLocalAppsExecutor = async (
  prisma: PrismaClient,
  actor: AuthorizedActionContext,
  input: {
    agentId: string
    codingSessions?: Record<string, unknown>
    executorId: string
    mcpServers: string[]
    organizationId: string
    userId: string
  },
): Promise<void> => {
  await prisma.executor.create({ data: {
    id: input.executorId, organizationId: input.organizationId, pairingOwnerUserId: input.userId,
    label: 'Owner workstation', scopeKind: 'private', status: 'online', lastSeenAt: new Date(),
    profiles: ['workspace_sandbox'],
    privateAssignments: { create: { principalKind: 'user', userId: input.userId, role: 'admin' } },
  } })
  const descriptor = ExecutorCapabilityDescriptorSchema.parse({
    protocolVersion: 1, revision: 1, profiles: ['workspace_sandbox'], operationKeys: ['mcp.tools', 'mcp.call'],
    mcpServers: input.mcpServers,
    ...(input.codingSessions ? { codingSessions: input.codingSessions } : {}),
    platform: { architecture: 'x64', os: 'windows', osMajorVersion: 26100 },
    supervisor: 'service', sandboxBackend: 'none', localPolicyDigest: `sha256:${'2'.repeat(64)}`,
    limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 2 },
  })
  await prisma.executorCapabilityRevision.create({ data: {
    executorId: input.executorId, revision: 1, descriptor, signature: 'reviewed-test-descriptor',
    localPolicyDigest: descriptor.localPolicyDigest, reviewStatus: 'active', reviewedByUserId: input.userId,
  } })
  const prepared = await prepareExecutorAccessChange(prisma, actor, {
    executorId: input.executorId, change: { kind: 'agent_executor_access', agentId: input.agentId, state: 'allowed' },
  })
  await confirmExecutorAccessChange(prisma, actor, {
    accessChangeId: prepared.accessChangeId, confirmationToken: prepared.confirmationToken,
    freshVerificationSatisfied: true,
  })
}

/** The person's launch: an opaque candidate bound to exactly this run. */
export const launchLocalApps = async (
  prisma: PrismaClient,
  actor: AuthorizedActionContext,
  input: { agentId: string; executorId: string; runId: string; userId: string },
): Promise<void> => {
  const availability = await resolveExecutorAvailabilityCandidates(prisma, actor, {
    agentId: input.agentId, executorId: input.executorId, operationKeys: ['mcp.tools', 'mcp.call'], runId: input.runId,
  })
  const candidate = availability.candidates[0]
  assert.ok(candidate, JSON.stringify(availability.explanations))
  await prisma.$transaction((tx) => bindExecutorCandidateBundleInTransaction(tx, {
    actorUserId: input.userId, candidateHandle: candidate.handle,
    operationKeys: ['mcp.tools', 'mcp.call'], runId: input.runId,
  }))
}

/** What the daemon received: the model's `args`, and the `owner` the worker stamped when it stamped one. */
export type DeliveredCommand = { args: Record<string, unknown>; operationKey: string; owner?: unknown }

/**
 * The daemon stand-in for one executor: the worker's queue claim, then poll,
 * run the daemon's own operation against `sessions` — with the daemon's own
 * coding-sessions bridge when given, which stamps the reserved `_meta` — and
 * the three receipts.
 */
export const startStandInDaemon = (
  prisma: PrismaClient,
  input: {
    codingBridge?: Pick<CodingSessionsDaemon, 'callMeta'>
    executorId: string
    sessions: ExecutorMcpSessionManager
  },
): { delivered: DeliveredCommand[]; stop: () => Promise<void> } => {
  const delivered: DeliveredCommand[] = []
  let running = true
  const loop = (async () => {
    while (running) {
      const leased = await prisma.executorCommand.findMany({
        where: { binding: { executorId: input.executorId }, state: 'leased' },
        select: { queueJobId: true },
      })
      await prisma.queueJob.updateMany({
        where: { id: { in: leased.map((command) => command.queueJobId) }, status: 'pending' },
        data: { lockedUntil: new Date(Date.now() + 300_000), status: 'processing' },
      })
      const envelope = await pollExecutorCommand(prisma, LANE_SECRET, input.executorId)
      if (!envelope) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        continue
      }
      const payload = envelope.payload as { args: Record<string, unknown>; owner?: unknown }
      delivered.push({
        args: payload.args, operationKey: envelope.operationKey,
        ...(payload.owner === undefined ? {} : { owner: payload.owner }),
      })
      const at = new Date().toISOString()
      await recordExecutorCommandReceipt(prisma, LANE_SECRET, input.executorId, { commandId: envelope.commandId, occurredAt: at, state: 'accepted' }, undefined)
      await recordExecutorCommandReceipt(prisma, LANE_SECRET, input.executorId, { commandId: envelope.commandId, occurredAt: at, state: 'started' }, undefined)
      const result = await executeExecutorMcpCommand(
        envelope.operationKey as 'mcp.tools' | 'mcp.call', payload.args, input.sessions,
        { ...(input.codingBridge ? { codingBridge: input.codingBridge } : {}), commandId: envelope.commandId, payload },
      )
      await recordExecutorCommandReceipt(prisma, LANE_SECRET, input.executorId, {
        commandId: envelope.commandId, occurredAt: new Date().toISOString(), resultDigest: digest(result),
        state: 'result_acknowledged',
      }, result)
    }
  })()
  return {
    delivered,
    stop: async () => {
      running = false
      await loop
    },
  }
}

/** Every row the lane wrote for these runs, then the executor itself. */
export const deleteLocalAppsLane = async (
  prisma: PrismaClient,
  input: { executorId: string; organizationId: string; runIds: string[] },
): Promise<void> => {
  const commands = await prisma.executorCommand.findMany({
    where: { binding: { runId: { in: input.runIds } } }, select: { id: true, queueJobId: true },
  })
  await prisma.executorCommand.deleteMany({ where: { id: { in: commands.map((command) => command.id) } } })
  await prisma.queueJob.deleteMany({ where: { id: { in: commands.map((command) => command.queueJobId) } } })
  await prisma.executorBinding.deleteMany({ where: { runId: { in: input.runIds } } })
  await prisma.run.deleteMany({ where: { id: { in: input.runIds } } })
  await prisma.executorAvailabilityCandidate.deleteMany({ where: { executorId: input.executorId } })
  await prisma.executor.deleteMany({ where: { id: input.executorId, organizationId: input.organizationId } })
}
