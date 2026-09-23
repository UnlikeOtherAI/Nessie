import type { PrismaClient } from '@prisma/client'
import { executorCodingSessionsAllowed } from '@nessie/executor-manage'
import { ExecutorCodingSessionsFactsSchema, type ExecutorCodingSessionsFacts } from '@nessie/schemas'
import type { ToolSchemaDescriptor } from '@nessie/runtime'

import {
  codingProgressLine,
  parseBridgeResult,
  presentCodingCall,
  presentCodingFailure,
  presentCodingWait,
} from './coding-session-presentation.js'
import {
  CODING_BRIDGE_TOOL,
  CODING_SESSION_TOOL_NAMES,
  codingBridgeArguments,
  codingSessionDescriptors,
  type CodingSessionToolName,
} from './coding-session-tools.js'
import { runCodingSessionWait, type CodingWaitTiming } from './coding-session-wait.js'
import type { ExecutorCommandOutcome } from './executor-command-dispatch.js'
import { ExecutorUnknownOutcomeError } from './executor-command-timing.js'
import { coerceToolArgumentsToSchema } from './tool-argument-coercion.js'
import { summarizeToolInput } from './tool-util.js'
import type { AgenticToolResult } from './tools.js'

/**
 * The first-class coding-session tools on top of the executor toolset's own
 * dispatch (docs/executor-protocol/host-coding-sessions.md → "The agent's
 * tools"). Every call here is an `mcp.call` to the bound revision's bridge,
 * made through the toolset exactly as `executor_mcp_call` would make it, so
 * the owner stamp, the disclosure stamp, the command TTL and the ToolCall row
 * are the toolset's and nothing here repeats them.
 */

/** What the agent loop lends a coding tool: the drain signal, and the thought-process line of a wait. */
export type CodingSessionHooks = {
  onProgress?: (toolName: string, line: string) => Promise<void>
  signal?: AbortSignal
}

export type ExecutorCodingSessions = {
  descriptors: ToolSchemaDescriptor[]
  /** The model-facing result of one call, shaped and framed. */
  execute: (
    toolName: CodingSessionToolName,
    args: Record<string, unknown>,
    providerToolCallId: string,
    hooks?: CodingSessionHooks,
  ) => Promise<AgenticToolResult>
  server: string
}

type OfferBinding = {
  candidateHandleDigest?: string | null
  capabilityRevision?: { descriptor: unknown } | null
  executor?: { pairingOwnerUserId: string; scopeKind: 'private' | 'project' | 'organization' } | null
  id: string
  operationKey: string
}

/**
 * The rule the tools are offered by (§1): the run's `mcp.call` binding is to
 * a revision whose descriptor has the bridge's facts, the agent's policy
 * allows that call, the executor is private, and the binding's candidate was
 * made for its pairing owner. The API refuses the same call at dispatch
 * whatever the worker offers; this only decides what the model is told.
 */
export const codingSessionsOffer = async (
  prisma: Pick<PrismaClient, 'executorAvailabilityCandidate'>,
  bindings: readonly OfferBinding[],
  mcpCallGranted: boolean,
): Promise<{ bindingId: string; facts: ExecutorCodingSessionsFacts } | null> => {
  const binding = bindings.find((entry) => entry.operationKey === 'mcp.call')
  if (!binding || !mcpCallGranted || !binding.executor || !binding.candidateHandleDigest) return null
  const facts = ExecutorCodingSessionsFactsSchema.safeParse(
    (binding.capabilityRevision?.descriptor as { codingSessions?: unknown } | null | undefined)?.codingSessions,
  )
  if (!facts.success) return null
  const candidate = await prisma.executorAvailabilityCandidate.findUnique({
    where: { handleDigest: binding.candidateHandleDigest },
    select: { actorUserId: true },
  })
  if (!candidate || !executorCodingSessionsAllowed(binding.executor, candidate.actorUserId)) return null
  return { bindingId: binding.id, facts: facts.data }
}

export const createExecutorCodingSessions = (input: {
  /** One `mcp.call` through the toolset's dispatch, its command expiring no later than `expiresBy`. */
  call: (
    toolName: CodingSessionToolName,
    args: Record<string, unknown>,
    providerToolCallId: string,
    expiresBy?: Date,
  ) => Promise<ExecutorCommandOutcome>
  /** Ends a ToolCall row the call's own answer will not end. */
  endRecord: (toolCallRecordId: string, result: AgenticToolResult, durationMs: number) => Promise<void>
  facts: ExecutorCodingSessionsFacts
  personWrote: () => Promise<boolean>
  stopRequested: () => Promise<boolean>
  timing?: CodingWaitTiming
}): ExecutorCodingSessions => {
  const server = input.facts.serverName
  // What this run has seen of each session: its turn, the last status a wait
  // ended on (to tell progress), and the turn a start or send still owes.
  const turns = new Map<string, number>()
  const lastSeen = new Map<string, string>()
  const owed = new Map<string, number>()

  const envelope = (toolName: CodingSessionToolName, args: Record<string, unknown>) => ({
    arguments: codingBridgeArguments(toolName, args, input.facts),
    server,
    tool: CODING_BRIDGE_TOOL[toolName],
  })

  const remember = (toolName: CodingSessionToolName, body: Record<string, unknown>): void => {
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : null
    if (toolName === CODING_SESSION_TOOL_NAMES.list && Array.isArray(body.sessions)) {
      for (const session of body.sessions as Array<Record<string, unknown>>) {
        if (typeof session.sessionId === 'string' && typeof session.turn === 'number') turns.set(session.sessionId, session.turn)
      }
    }
    if (!sessionId || body.replayed === true) return
    if (toolName === CODING_SESSION_TOOL_NAMES.start) owed.set(sessionId, 0)
    // A message to a working session folds into its running turn; to any
    // other it starts the next one, which is the answer a wait must see.
    if (toolName === CODING_SESSION_TOOL_NAMES.send && body.status !== 'working' && turns.has(sessionId)) {
      owed.set(sessionId, turns.get(sessionId)!)
    }
    if (toolName === CODING_SESSION_TOOL_NAMES.close) owed.delete(sessionId)
  }

  const once = async (
    toolName: CodingSessionToolName, args: Record<string, unknown>, providerToolCallId: string,
  ): Promise<AgenticToolResult> => {
    const outcome = await input.call(toolName, envelope(toolName, args), providerToolCallId)
    if (outcome.kind === 'expired') throw new ExecutorUnknownOutcomeError(outcome.toolCallRecordId)
    const parsed = parseBridgeResult(outcome.result)
    if (parsed.kind === 'answer') remember(toolName, parsed.body)
    return { ...presentCodingCall(toolName, server, parsed, outcome.result), inputSummary: summarizeToolInput(args) }
  }

  const wait = async (
    args: Record<string, unknown>, providerToolCallId: string, hooks: CodingSessionHooks,
  ): Promise<AgenticToolResult> => {
    const toolName = CODING_SESSION_TOOL_NAMES.wait
    const sessionId = typeof args.sessionId === 'string' ? args.sessionId : ''
    const inputSummary = summarizeToolInput(args)
    const call = envelope(toolName, args)
    // The first read's row is the call's own, which the agent loop ends with
    // the digest; every later read's row is ended here as soon as it answers.
    let firstRecordId: string | undefined
    const startedAt = Date.now()
    let waited: Awaited<ReturnType<typeof runCodingSessionWait>>
    try {
      waited = await runCodingSessionWait({
        ...(owed.has(sessionId) ? { awaitTurnAbove: owed.get(sessionId)! } : {}),
        ...(hooks.onProgress
          ? { onProgress: (body, activity) => hooks.onProgress!(toolName, codingProgressLine(body, activity)) }
          : {}),
        personWrote: input.personWrote,
        poll: async (index, expiresBy) => {
          const pollStartedAt = Date.now()
          const outcome = await input.call(toolName, call, index === 0 ? providerToolCallId : `${providerToolCallId}:poll-${index}`, expiresBy)
          if (outcome.kind === 'expired') {
            const expiredId = outcome.toolCallRecordId
            if (index === 0) firstRecordId = expiredId
            // Its own TTL ran out: an unknown outcome like any command's.
            if (!outcome.capped) throw new ExecutorUnknownOutcomeError(expiredId)
            if (index > 0) {
              await input.endRecord(expiredId, { inputSummary, output: 'No answer before the wait ended.', success: false }, Date.now() - pollStartedAt)
            }
            return { kind: 'expired' }
          }
          const recordId = outcome.result.toolCallRecordId
          if (index === 0) firstRecordId = recordId
          else if (recordId) await input.endRecord(recordId, outcome.result, Date.now() - pollStartedAt)
          const parsed = parseBridgeResult(outcome.result)
          if (parsed.kind !== 'answer') return { kind: 'failed', result: presentCodingFailure(parsed, outcome.result) }
          if (typeof parsed.body.turn === 'number') turns.set(sessionId, parsed.body.turn)
          return { body: parsed.body, kind: 'answer' }
        },
        ...(hooks.signal ? { signal: hooks.signal } : {}),
        stopRequested: input.stopRequested,
        ...(input.timing ? { timing: input.timing } : {}),
      })
    } catch (error) {
      // The row an unknown outcome names is the batch's to end; the call's own
      // row, when that is another, is nobody's but ours now.
      const thrown = error instanceof Error
        ? (error as Error & { toolCallRecordId?: unknown }).toolCallRecordId
        : undefined
      if (firstRecordId && firstRecordId !== thrown) {
        await input.endRecord(firstRecordId, { inputSummary, output: 'The wait stopped.', success: false }, Date.now() - startedAt)
          .catch(() => undefined)
      }
      throw error
    }
    const recordIdField = firstRecordId ? { toolCallRecordId: firstRecordId } : {}
    if (waited.kind === 'failed') return { ...waited.result, inputSummary, ...recordIdField }
    const { activity, last, outcome } = waited
    const signature = `${String(last.status)}|${String(last.turn)}`
    const progressed = activity.newEvents > 0 || lastSeen.get(sessionId) !== signature
    lastSeen.set(sessionId, signature)
    const expected = owed.get(sessionId)
    if (expected !== undefined && (outcome === 'attention' || outcome === 'window'
      || (typeof last.turn === 'number' && last.turn > expected))) owed.delete(sessionId)
    await hooks.onProgress?.(toolName, codingProgressLine(last, activity)).catch(() => undefined)
    return {
      inputSummary,
      output: presentCodingWait(waited),
      success: true,
      ...recordIdField,
      watchProgressed: progressed,
    }
  }

  const descriptors = codingSessionDescriptors(input.facts)
  const schemaOf = new Map(descriptors.map((descriptor) => [descriptor.toolName, descriptor.inputSchema]))
  return {
    descriptors,
    execute: (toolName, modelArgs, providerToolCallId, hooks = {}) => {
      // The builtins' rule, against the tool's own schema: `"4096"` for an
      // integer, an object sent as a JSON string.
      const args = coerceToolArgumentsToSchema(schemaOf.get(toolName), modelArgs)
      return toolName === CODING_SESSION_TOOL_NAMES.wait
        ? wait(args, providerToolCallId, hooks)
        : once(toolName, args, providerToolCallId)
    },
    server,
  }
}

/**
 * The two questions a wait asks between reads, from the run's own rows: was
 * the run stopped, and has a person written to this agent in this
 * conversation since it began — a live chat message waiting for the run to
 * end (`RunThreadPendingMessage`), not a trigger's fire.
 */
export const codingWaitRunChecks = (
  prisma: Pick<PrismaClient, 'run' | 'runThreadPendingMessage'>,
  input: { agentId: string; runId: string },
) => {
  let thread: Promise<{ principalUserId: string | null; threadId: string } | null> | undefined
  return {
    personWrote: async (): Promise<boolean> => {
      thread ??= prisma.run.findUnique({
        where: { id: input.runId }, select: { principalUserId: true, threadId: true },
      })
      const run = await thread
      if (!run) return false
      const pending = await prisma.runThreadPendingMessage.findFirst({
        where: {
          agentId: input.agentId,
          interactive: true,
          principalUserId: run.principalUserId,
          threadId: run.threadId,
          triggerId: null,
        },
        select: { seq: true },
      })
      return pending !== null
    },
    stopRequested: async (): Promise<boolean> => {
      const run = await prisma.run.findUnique({ where: { id: input.runId }, select: { cancelRequestedAt: true } })
      return run?.cancelRequestedAt != null
    },
  }
}
