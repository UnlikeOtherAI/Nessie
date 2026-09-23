import type { PrismaClient } from '@prisma/client'
import {
  DeepWaterRequesterIdentitySchema,
  type AuthorizedActionContext,
  type DeepWaterRequesterIdentity,
  type UoaSessionIdentity,
} from '@nessie/schemas'

import type { DeepWaterRealtime } from '../control/deepwater-announce.js'
import type { ConsumedSourceSink } from './execute/disclosure-basis.js'
import { deepWaterToolRefusal } from './deepwater-tool-guidance.js'
import type { ToolDispatchResult } from './tool-dispatch.js'

/**
 * What the DeepWater run binder knows about the agent run whose tool calls it
 * binds (Water plan nessie.md §7.4), and the shape of what it hands back to
 * the toolset. Built once per run in run setup.
 */
export type DeepWaterRunBinderContext = {
  prisma: PrismaClient
  realtime: DeepWaterRealtime
  organizationId: string
  /** The run's team; a brief lives in one. Null for a run outside any team. */
  teamId: string | null
  agentId: string
  /** The calling Nessie Run. */
  runId: string
  /** The Run's principal (a Personal Assistant's person), kept for its wakes. */
  principalUserId: string | null
  channelId: string
  threadId: string
  /** The person the agent acts for — every brief's requester. */
  effectiveUserId: string | null
  /** Their live UOA session identity, as the run's actor context carries it. */
  uoaIdentity: UoaSessionIdentity | undefined
  /** The same identity as a brief captures it: only with a login epoch. */
  requesterIdentity: DeepWaterRequesterIdentity | null
  consumedSources: ConsumedSourceSink
}

/**
 * The binder's view of a run, from its actor context: the team and the person
 * resolve exactly as the MCP toolset scopes the run (`buildMcpRunScopeContext`),
 * so the binder and the connector it binds agree on both.
 */
export const deepWaterRunBinderContext = (input: {
  prisma: PrismaClient
  realtime: DeepWaterRealtime
  actorContext: AuthorizedActionContext
  agentId: string
  runId: string
  principalUserId: string | null
  channelId: string
  threadId: string
  consumedSources: ConsumedSourceSink
}): DeepWaterRunBinderContext => {
  const { actorContext } = input
  const uoaIdentity = actorContext.actionContext.uoaIdentity
  const requesterIdentity = DeepWaterRequesterIdentitySchema.safeParse(uoaIdentity)
  return {
    prisma: input.prisma,
    realtime: input.realtime,
    organizationId: actorContext.tenant.organizationId,
    teamId: actorContext.tenant.teamId ?? actorContext.actionContext.teamId ?? null,
    agentId: input.agentId,
    runId: input.runId,
    principalUserId: input.principalUserId,
    channelId: input.channelId,
    threadId: input.threadId,
    effectiveUserId: actorContext.actionContext.effectiveUserId
      ?? (actorContext.actor.actorType === 'user' ? actorContext.actor.actorId : null),
    uoaIdentity,
    requesterIdentity: requesterIdentity.success ? requesterIdentity.data : null,
    consumedSources: input.consumedSources,
  }
}

/** The one transport call, with the stable tool-call id and exact arguments. */
export type DeepWaterSend = (toolCallId: string, args: Record<string, unknown>) => Promise<ToolDispatchResult>

export type DeepWaterBoundDispatch = {
  result: ToolDispatchResult
  /** False when the binder answered without calling Ledger. */
  transportInvoked: boolean
}

/** A definitive tool error the binder answers without calling Ledger. */
export const refused = (code: string, message: string): DeepWaterBoundDispatch => ({
  result: { success: false, output: deepWaterToolRefusal(code, message), raw: null },
  transportInvoked: false,
})

/** Ledger's structured answer, when the transport returned one. */
export const structuredOf = (result: ToolDispatchResult): unknown => {
  const raw = result.raw as { structuredContent?: unknown } | null
  return raw && typeof raw === 'object' ? raw.structuredContent : undefined
}

/** Ledger's answer as the agent reads it, followed by the binder's note. */
export const withGuidance = (result: ToolDispatchResult, guidance: string): ToolDispatchResult => ({
  ...result,
  output: `${result.output}\n\n${guidance}`,
})
