import type { Prisma, PrismaClient } from '@prisma/client'
import {
  deepWaterPersonOriginSources,
  enqueueDeepWaterBriefAction,
  findDeepWaterBriefRunByOrigin,
  insertDeepWaterBriefRun,
  type DeepWaterBriefRunInsertResult,
} from '@nessie/runtime'
import type {
  DeepWaterBriefInput,
  DeepWaterDisclosureSource,
  DeepWaterRequesterIdentity,
  DeepWaterSourceScope,
} from '@nessie/schemas'
import { acquireAgentToolPolicyLock, normalizeToolPolicy } from '@nessie/team-admin'

import {
  findDeepWaterToolPolicyKey,
  readDeepWaterTeamConnector,
} from './deepwater-team-connector.js'
import { runWithDeepWaterTransitionLock } from './deepwater-transition-lock.js'

/**
 * Where a DeepWater research brief comes to exist (Water plan amendments N8.2).
 *
 * Both paths run inside the team's DeepWater transition lock, the lock a team
 * disable, a contract upgrade and a grant revocation take, and re-read the
 * team's switch and current-contract connector there. So a brief either exists
 * before a disable or revocation looks for open runs — and blocks it — or sees
 * the team off and is never written. The run is bound to that connector.
 */

export type DeepWaterNotReadyReason = 'team_off' | 'contract_outdated' | 'unavailable'

export class DeepWaterBriefNotReadyError extends Error {
  override readonly name = 'DeepWaterBriefNotReadyError'
  readonly code = 'DEEP_WATER_NOT_READY'

  constructor(readonly reason: DeepWaterNotReadyReason) {
    super(`DeepWater is not ready for this team (${reason})`)
  }
}

/** The agent's policy no longer grants `research_scope_start` on this team's connector. */
export class DeepWaterAgentGrantMissingError extends Error {
  override readonly name = 'DeepWaterAgentGrantMissingError'
  readonly code = 'DEEP_WATER_AGENT_GRANT_MISSING'

  constructor(readonly agentId: string) {
    super(`Agent ${agentId} is no longer granted DeepWater research briefs on this team`)
  }
}

/** The brief's origin thread is gone, or not in this organisation's channel. */
export class DeepWaterBriefOriginNotFoundError extends Error {
  override readonly name = 'DeepWaterBriefOriginNotFoundError'
  readonly code = 'THREAD_NOT_FOUND'

  constructor(readonly threadId: string) {
    super(`DeepWater brief origin thread ${threadId} was not found`)
  }
}

const SCOPE_START_TOOL_NAME = 'research_scope_start'

type BriefRunCommon = {
  organizationId: string
  teamId: string
  requestedByUserId: string
  channelId: string
  threadId: string
  /** The requester's live UOA identity, captured for every later read and wake. */
  identity: DeepWaterRequesterIdentity
  input: DeepWaterBriefInput
}

const requireReadyConnector = async (
  tx: Prisma.TransactionClient,
  input: { organizationId: string; teamId: string },
): Promise<string> => {
  const connector = await readDeepWaterTeamConnector(tx, input)
  if (connector.state !== 'ready') throw new DeepWaterBriefNotReadyError(connector.state)
  return connector.instanceId
}

/**
 * The sources a person's brief starts with, read from its origin room in the
 * creating transaction (N6): the room's scope and the person's lineage when
 * the room is not public, nothing when it is. Decided here, never by a caller.
 */
const personOriginSources = async (tx: Prisma.TransactionClient, input: BriefRunCommon) => {
  const thread = await tx.thread.findFirst({
    where: {
      id: input.threadId,
      channelId: input.channelId,
      channel: { organizationId: input.organizationId, deletedAt: null },
    },
    select: { channel: { select: { visibility: true, systemChannelType: true } } },
  })
  if (!thread) throw new DeepWaterBriefOriginNotFoundError(input.threadId)
  return deepWaterPersonOriginSources({
    channelId: input.channelId,
    channelVisibility: thread.channel.visibility,
    systemChannelType: thread.channel.systemChannelType,
    requesterUserId: input.requestedByUserId,
  })
}

/**
 * A person opens a brief (`POST …/research-runs`). The row is written with its
 * opening `scope_start` in flight and that action enqueued, in one
 * transaction. Replaying the same `actionId` returns the brief it opened, even
 * if the team has since turned DeepWater off.
 */
export const createPersonDeepWaterBrief = (
  prisma: PrismaClient,
  input: BriefRunCommon & { actionId: string },
): Promise<DeepWaterBriefRunInsertResult> =>
  runWithDeepWaterTransitionLock(prisma, input, async (tx) => {
    const origin = { kind: 'person' as const, actionId: input.actionId }
    const existing = await findDeepWaterBriefRunByOrigin(tx, {
      organizationId: input.organizationId,
      requestedByUserId: input.requestedByUserId,
      origin,
    })
    if (existing) return { run: existing, created: false }

    const connectorId = await requireReadyConnector(tx, input)
    const sources = await personOriginSources(tx, input)
    const inserted = await insertDeepWaterBriefRun(tx, { ...input, ...sources, connectorId, origin })
    if (inserted.created) {
      await enqueueDeepWaterBriefAction(tx, {
        organizationId: input.organizationId,
        runId: inserted.run.id,
        actionId: input.actionId,
        actor: { userId: input.requestedByUserId, role: 'requester', identity: input.identity },
        action: { kind: 'scope_start' },
      })
    }
    return inserted
  })

/**
 * An agent's `research_scope_start` claims its run before the call reaches
 * Ledger, so every brief has a durable addressee even if the call never
 * returns. Keyed by the calling Run and its provider tool-call id: a retried
 * call finds the row it already claimed. The agent's grant is re-read under
 * its policy lock (after the team lock, the order every DeepWater path uses),
 * so a revocation racing the claim either sees this row or refuses it.
 */
export const claimAgentOriginRun = (
  prisma: PrismaClient,
  input: BriefRunCommon & {
    agentId: string
    originRunId: string
    toolCallId: string
    principalUserId: string | null
    /**
     * The calling run's consumed sources at dispatch (N6):
     * `consumedSources.list()` and `consumedSources.privateConversationSources()`.
     */
    sourceScopes: DeepWaterSourceScope[]
    disclosureSources: DeepWaterDisclosureSource[]
  },
): Promise<DeepWaterBriefRunInsertResult> =>
  runWithDeepWaterTransitionLock(prisma, input, async (tx) => {
    const origin = {
      kind: 'agent' as const,
      agentId: input.agentId,
      runId: input.originRunId,
      toolCallId: input.toolCallId,
      principalUserId: input.principalUserId,
    }
    const existing = await findDeepWaterBriefRunByOrigin(tx, {
      organizationId: input.organizationId,
      requestedByUserId: input.requestedByUserId,
      origin,
    })
    if (existing) return { run: existing, created: false }

    const connectorId = await requireReadyConnector(tx, input)
    await acquireAgentToolPolicyLock(tx, input.agentId)
    const [policyKey, agent] = await Promise.all([
      findDeepWaterToolPolicyKey(tx, {
        organizationId: input.organizationId,
        instanceId: connectorId,
        toolName: SCOPE_START_TOOL_NAME,
      }),
      tx.agent.findFirst({
        where: { id: input.agentId, organizationId: input.organizationId },
        select: { toolPolicy: true },
      }),
    ])
    if (!policyKey || !agent || normalizeToolPolicy(agent.toolPolicy)[policyKey] !== true) {
      throw new DeepWaterAgentGrantMissingError(input.agentId)
    }
    return insertDeepWaterBriefRun(tx, { ...input, connectorId, origin })
  })
