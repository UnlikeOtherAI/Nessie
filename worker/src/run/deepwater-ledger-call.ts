import type { PrismaClient } from '@prisma/client'
import {
  McpNotConnectedError,
  McpTimeoutError,
  McpTransportError,
} from '@nessie/mcp-client'
import {
  LedgerIdentityError,
  classifyUoaExchangeFailure,
  completeLedgerAttribution,
  isRequesterIdentityRefusal,
  type DeepWaterBriefRun,
  type LedgerAttribution,
  type LedgerIdentityService,
} from '@nessie/runtime'
import {
  LedgerToolErrorSchema,
  type DeepWaterRequesterIdentity,
  type LedgerToolError,
} from '@nessie/schemas'

import {
  addDeepWaterIdentityHeaders,
  loadDeepWaterConnectorTransport,
} from './deepwater-ledger-transport.js'
import { recordMcpConnectorUsage } from './mcp-usage.js'
import { dispatchTool } from './tool-dispatch.js'

/**
 * The worker's own DeepWater calls to Ledger, outside any agent run (Water plan
 * amendments-fable F7.1): the watch's reads, delivery's report read, a
 * person's brief actions and the replay of an agent's lost scope start. Each
 * call goes over the run's own team connector with Nessie's product-bound app
 * key and a signed identity built for the kind of call (contract §7.3).
 *
 * Every call is a cost-free control-plane call: the paid work happens in
 * Water under Ledger job compute (contract §8). Each still writes Nessie's
 * operational `connector_usage_events` row, as agent tool calls do.
 */

/** Ledger aborts its own Water calls at 20 s, so 30 s covers every scope tool (amendments L3). */
export const DEEP_WATER_CALL_TIMEOUT_MS = 30_000

/** `research_report` returns up to 2 MB of report. */
export const DEEP_WATER_REPORT_TIMEOUT_MS = 120_000

export type DeepWaterSystemComponent = 'deep-water.brief' | 'deep-water.delivery' | 'deep-water.owner-cancel'

export type DeepWaterLedgerOutcome =
  | { outcome: 'ok'; structured: Record<string, unknown> }
  /** Ledger answered with a structured tool error. */
  | { outcome: 'refused'; error: LedgerToolError }
  /** Nothing is known: the call may or may not have reached Ledger. Retry with the same tool_call_id. */
  | { outcome: 'unavailable'; reason: string }
  /**
   * The captured UOA identity no longer resolves to the requester's linked
   * account and team, or UOA refused to delegate it (their sign-in epoch moved
   * or they lost the organisation or team). Only they can fix it.
   */
  | { outcome: 'identity'; reason: string }
  /** Ledger answered outside its contract: a success with no structured result, or an uncoded error. */
  | { outcome: 'malformed'; reason: string }
  /** The run's team connector is gone or no longer active. */
  | { outcome: 'connector_missing' }

/** A refusal Ledger expects to be retried with the same tool_call_id. */
export const isTransientLedgerRefusal = (error: LedgerToolError): boolean =>
  error.code === 'upstream_unavailable'
  || error.statusCode === 408
  || error.statusCode === 429
  || (error.statusCode !== null && error.statusCode >= 500)

/**
 * A DeepWater system job acting for a brief's requester: the person brief
 * dialog (`deep-water.brief`), the watch and delivery (`deep-water.delivery`),
 * or an owner's cancel (`deep-water.owner-cancel`, with the owner's own user
 * and identity). Its agent id is the component's stable system-agent id and
 * its run id the product run, so Ledger sees the same caller on every call.
 */
export const deepWaterSystemAttribution = (
  run: DeepWaterBriefRun,
  input: {
    systemComponent: DeepWaterSystemComponent
    identity: DeepWaterRequesterIdentity
    /** The acting person when it is not the requester (an owner's cancel). */
    userId?: string
  },
): LedgerAttribution => {
  const userId = input.userId ?? run.requestedByUserId
  if (!userId) {
    throw new Error(`DeepWater run ${run.id} has no requester to act for`)
  }
  return completeLedgerAttribution({
    organizationId: run.organizationId,
    teamId: run.teamId,
    userId,
    runId: run.id,
    channelId: run.channelId,
    threadId: run.threadId,
    agentKind: null,
    systemComponent: input.systemComponent,
    actorId: userId,
    actorType: 'system',
    uoaIdentity: input.identity,
  })
}

/**
 * The agent's own call identity for an agent-origin brief: its Run, its agent
 * and kind. Replaying the agent's `research_scope_start` with this and the
 * original tool-call id is how a scope start whose result was lost finds (or
 * finishes creating) the one brief Ledger keyed to that call.
 */
export const deepWaterAgentOriginAttribution = (
  run: DeepWaterBriefRun,
  input: { agentKind: 'personal_assistant' | 'shared'; identity: DeepWaterRequesterIdentity },
): LedgerAttribution => {
  if (!run.originAgentId || !run.originRunId || !run.requestedByUserId) {
    throw new Error(`DeepWater run ${run.id} has lost its origin agent, run or requester`)
  }
  return {
    organizationId: run.organizationId,
    teamId: run.teamId,
    userId: run.requestedByUserId,
    runId: run.originRunId,
    agentId: run.originAgentId,
    agentKind: input.agentKind,
    channelId: run.channelId,
    threadId: run.threadId,
    actorId: run.originAgentId,
    actorType: 'agent',
    uoaIdentity: input.identity,
  }
}

export type DeepWaterLedgerCallDeps = {
  prisma: PrismaClient
  ledgerIdentity: LedgerIdentityService | null
  /** Test seam for the one transport call. */
  dispatchMcpTool?: typeof dispatchTool
}

const isUnavailable = (error: unknown): error is Error =>
  error instanceof McpTimeoutError
  || error instanceof McpTransportError
  || error instanceof McpNotConnectedError

/**
 * Call one DeepWater tool through a run's team connector. Signing, transport
 * and Ledger's answer are each classified; a deployment fault (no signer, no
 * app key, UOA refusing Nessie's client or assertion, Ledger refusing the
 * bearer) throws.
 */
export const callDeepWaterLedgerTool = async (
  deps: DeepWaterLedgerCallDeps,
  input: {
    organizationId: string
    connectorId: string
    attribution: LedgerAttribution
    toolCallId: string
    toolName: string
    args: Record<string, unknown>
    timeoutMs?: number
  },
): Promise<DeepWaterLedgerOutcome> => {
  const transport = await loadDeepWaterConnectorTransport(deps.prisma, input)
  if (!transport) return { outcome: 'connector_missing' }

  let signed
  try {
    signed = await addDeepWaterIdentityHeaders(transport, deps.ledgerIdentity, input.attribution, input.toolCallId)
  } catch (error) {
    // A failed exchange is only as retryable as UOA says: a refusal of this
    // person (or no linked identity at all) is identity drift, an outage
    // passes, and anything else is a deployment fault that repeating would
    // only repeat.
    if (isRequesterIdentityRefusal(error)) {
      return { outcome: 'identity', reason: error instanceof Error ? error.message : 'identity refused' }
    }
    if (
      error instanceof LedgerIdentityError
      && error.code === 'LEDGER_UOA_TOKEN_EXCHANGE_FAILED'
      && classifyUoaExchangeFailure(error.exchangeFailure) === 'transient'
    ) {
      return { outcome: 'unavailable', reason: error.message }
    }
    throw error
  }

  const startedAt = Date.now()
  const record = (success: boolean) => recordMcpConnectorUsage(deps.prisma, input.attribution, {
    connectorId: input.connectorId,
    latencyMs: Date.now() - startedAt,
    operation: input.toolName,
    success,
  })
  let result
  try {
    result = await (deps.dispatchMcpTool ?? dispatchTool)({
      spec: { transport: 'mcp', connection: signed, toolName: input.toolName },
      args: input.args,
      secret: null,
      timeoutMs: input.timeoutMs ?? DEEP_WATER_CALL_TIMEOUT_MS,
    })
  } catch (error) {
    await record(false)
    if (isUnavailable(error)) return { outcome: 'unavailable', reason: error.message }
    throw error
  }
  await record(result.success)

  const raw = result.raw as { structuredContent?: unknown } | null
  const structured = raw && typeof raw === 'object' ? raw.structuredContent : undefined
  if (!result.success) {
    const refusal = LedgerToolErrorSchema.safeParse(structured)
    return refusal.success
      ? { outcome: 'refused', error: refusal.data }
      : { outcome: 'malformed', reason: `${input.toolName} failed without a structured error` }
  }
  if (!structured || typeof structured !== 'object' || Array.isArray(structured)) {
    return { outcome: 'malformed', reason: `${input.toolName} succeeded without a structured result` }
  }
  return { outcome: 'ok', structured: structured as Record<string, unknown> }
}
