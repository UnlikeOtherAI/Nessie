import {
  ensureExecutorLogicalTools,
  reviewedCodingSessionsServer,
} from '@nessie/executor-manage'
import { EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME, ExecutorMcpServerNamesSchema } from '@nessie/schemas'
import type { PrismaClient } from '@prisma/client'
import type { ToolSchemaDescriptor } from '@nessie/runtime'

import { CODING_SESSION_TOOL_NAMES, isCodingSessionToolName } from './coding-session-tools.js'
import { CODING_WAIT_TOOL_TIMEOUT_MS } from './coding-session-wait.js'
import {
  codingSessionsOffer,
  codingWaitRunChecks,
  createExecutorCodingSessions,
  type ExecutorCodingSessions,
} from './executor-coding-sessions.js'
import {
  createExecutorCommandDispatch,
  EXECUTOR_COMMAND_TOPIC,
  executorDispatchResult,
  type ExecutorCommandTarget,
} from './executor-command-dispatch.js'
import { executorToolTimeouts, ExecutorUnknownOutcomeError } from './executor-command-timing.js'
import { HOST_OUTPUT_OPERATION_KEYS, type ExecutorHostOutputDisclosure } from './executor-host-output.js'
import { createExecutorMcpCatalogs, type ExecutorMcpCatalogAnswer } from './executor-mcp-catalog.js'
import { descriptorFor, executorToolName } from './executor-tool-descriptors.js'
import { shapeExecutorToolArguments } from './executor-tool-arguments.js'
import {
  TICKET_WORK_CODING_WAIT_TIMING,
  TICKET_WORK_CODING_WAIT_TOOL_TIMEOUT_MS,
  ticketWorkCodingDescriptors,
  ticketWorkCodingObserver,
  ticketWorkCodingSessions,
  type TicketWorkCodingScope,
} from './ticket-work-coding-sessions.js'
import { summarizeToolInput } from './tool-util.js'
import type { AgenticToolResult } from './tools.js'

// The descriptors and the command machinery live in their own modules; these
// names stay importable from here.
export { descriptorFor, EXECUTOR_COMMAND_TOPIC, executorDispatchResult, executorToolName }

type ExecutorEntry = ExecutorCommandTarget & {
  /** The bridge's names on the bound revision, which the generic pair never reaches. */
  codingBridgeNames: ReadonlySet<string>
  descriptor: ToolSchemaDescriptor
  mcpServers: readonly string[]
  toolName: string
}

const compareToolName = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

/** The local programs a bound revision's reviewed policy names; none when it names none. */
const reviewedMcpServers = (descriptor: unknown): readonly string[] => {
  const named = ExecutorMcpServerNamesSchema.safeParse(
    (descriptor as { mcpServers?: unknown } | null | undefined)?.mcpServers,
  )
  return named.success ? named.data : []
}

/**
 * The coding bridge's names on a revision: the reserved one, and the one its
 * reviewed facts give. The generic pair names neither, whether or not this
 * run is offered the coding tools: with them the model reaches the bridge
 * through them alone, and without them the API refuses every call to it.
 */
const codingBridgeNames = (descriptor: unknown): ReadonlySet<string> => {
  const reviewed = reviewedCodingSessionsServer(descriptor)
  return new Set([EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME, ...(reviewed === null ? [] : [reviewed])])
}

export type ExecutorToolset = {
  /**
   * The first-class coding-session tools, when this run is offered them
   * (`executor-coding-sessions.ts`); `dispatch` answers their names too, and
   * the agent loop calls `execute` itself to lend a wait its hooks.
   */
  codingSessions: ExecutorCodingSessions | null
  descriptors: ToolSchemaDescriptor[]
  dispatch: (toolName: string, args: Record<string, unknown>, providerToolCallId: string) => Promise<AgenticToolResult>
  handledNames: Set<string>
  /**
   * A local program's whole catalog, walked page by page through `mcp.tools`
   * the first time this run asks and kept for the rest of it.
   */
  mcpCatalog: (server: string, providerToolCallId: string) => Promise<ExecutorMcpCatalogAnswer>
  /**
   * Fatal and replay-safe for this run's executor tools, naming the ToolCall
   * the provider call's command was recorded under; null for any other name.
   */
  timeoutErrorFor: (toolName: string, providerToolCallId?: string) => Error | null
  /** Command TTL plus margin for this run's executor tools; undefined for any other name. */
  timeoutMsFor: (toolName: string) => number | undefined
}

export const buildExecutorToolset = async (
  prisma: PrismaClient,
  input: {
    agentToolPolicy: Record<string, boolean> | null
    agentId: string
    encryptionSecret: import('@nessie/runtime').EncryptionKeyRingInput | undefined
    /**
     * Where a local program's output may be shown (`executor-host-output.ts`).
     * Required so every caller decides: null only for a caller that is not a
     * person's launch in a conversation, and that caller says why.
     */
    hostOutput: ExecutorHostOutputDisclosure | null
    organizationId: string
    runId: string
    /**
     * A `ticket.work` run the standing binder bound: its coding tools are the
     * ticket's own (`ticket-work-coding-sessions.ts`).
     */
    ticketWork?: TicketWorkCodingScope | null
  },
): Promise<ExecutorToolset> => {
  const encryptionSecret = input.encryptionSecret
  if (!encryptionSecret) {
    const unavailable = { inputSummary: '', output: 'Executor transport is unavailable.', success: false }
    return {
      codingSessions: null,
      descriptors: [],
      dispatch: async () => unavailable,
      handledNames: new Set(),
      mcpCatalog: async () => ({ failure: unavailable }),
      ...executorToolTimeouts(() => undefined),
    }
  }
  const [logicalTools, bindings] = await Promise.all([
    ensureExecutorLogicalTools(prisma, input.organizationId),
    prisma.executorBinding.findMany({
      where: { runId: input.runId },
      select: {
        // The bound revision's reviewed policy names the local programs the
        // two mcp tools may reach, and the model is told exactly those.
        capabilityRevision: { select: { descriptor: true } },
        // Who the binding was made for, and whose machine it is: the coding
        // tools are offered only to a private executor's pairing owner.
        candidateHandleDigest: true,
        executorId: true,
        executor: { select: { pairingOwnerUserId: true, scopeKind: true } },
        id: true,
        operationKey: true,
        session: { select: { id: true, profile: true, status: true } },
        standingPolicyId: true,
        ticketWorkId: true,
      },
    }),
  ])
  // A ticket's work bound through a standing policy gets the coding-session
  // tools and nothing else: the author's card consented to Claude Code
  // sessions on these machines, not to the machine's other reviewed programs.
  // So the generic pair is never offered to it, and the dispatch fence
  // refuses it too (`standingProgramRefusal`). Standing whenever a binding of
  // the run says so, whether or not the ticket's coding scope loaded — and
  // with no scope, not even the coding tools are offered.
  const standing = Boolean(input.ticketWork)
    || bindings.some((binding) => Boolean(binding.standingPolicyId || binding.ticketWorkId))
  const mcpCallToolId = logicalTools.get('mcp.call')
  const codingOffer = standing && !input.ticketWork ? null : await codingSessionsOffer(
    prisma,
    bindings,
    mcpCallToolId !== undefined && input.agentToolPolicy?.[mcpCallToolId] === true,
  )
  const codingOperationKeys = new Set(['coding.launch', 'coding.observe', 'workspace.review', 'sandbox.stop'])
  const browserBindings = bindings.filter((binding) => (
    binding.operationKey === 'browser.open'
    || binding.operationKey === 'browser.observe'
    || binding.operationKey === 'browser.act'
    || (
      binding.operationKey === 'sandbox.stop'
      && binding.session?.profile === 'workspace_sandbox'
    )
  ))
  const hasBrowserActionBinding = bindings.some((binding) => (
    binding.operationKey === 'browser.open'
    || binding.operationKey === 'browser.observe'
    || binding.operationKey === 'browser.act'
  ))
  const browserSessionId = browserBindings[0]?.session?.id
  const browserSessionLive = browserBindings.every((binding) => (
    binding.session?.status === 'pending' || binding.session?.status === 'active'
  ))
  const hasExactBrowserBundle = Boolean(
    browserSessionId
    && bindings.length === 4
    && browserBindings.length === 4
    && browserBindings.every((binding) => binding.session?.id === browserSessionId)
    && browserBindings.some((binding) => binding.operationKey === 'browser.open')
    && browserBindings.some((binding) => binding.operationKey === 'browser.observe')
    && browserBindings.some((binding) => binding.operationKey === 'browser.act')
    && browserBindings.some((binding) => binding.operationKey === 'sandbox.stop')
    && browserSessionLive,
  )
  const codingBindings = bindings.filter((binding) => binding.session?.profile === 'coding_session')
  const codingSessionId = codingBindings[0]?.session?.id
  const codingSessionLive = codingBindings.every((binding) => (
    binding.session?.status === 'pending'
    || binding.session?.status === 'active'
    || binding.session?.status === 'attention'
  ))
  const hasExactCodingBundle = Boolean(
    codingSessionId
    && bindings.length === 4
    && codingBindings.length === 4
    && codingBindings.every((binding) => binding.session?.id === codingSessionId)
    && [...codingOperationKeys].every((operationKey) => (
      codingBindings.some((binding) => binding.operationKey === operationKey)
    ))
    && codingSessionLive,
  )
  const commandOperationKeys = new Set(['command.run', 'workspace.review', 'sandbox.stop'])
  const commandBindings = bindings.filter((binding) => (
    binding.session?.profile === 'workspace_sandbox'
    && commandOperationKeys.has(binding.operationKey)
  ))
  const commandSessionId = commandBindings[0]?.session?.id
  const commandSessionLive = commandBindings.every((binding) => (
    binding.session?.status === 'pending' || binding.session?.status === 'active'
  ))
  const hasExactCommandBundle = Boolean(
    commandSessionId
    && bindings.length === 3
    && commandBindings.length === 3
    && commandBindings.every((binding) => binding.session?.id === commandSessionId)
    && [...commandOperationKeys].every((operationKey) => (
      commandBindings.some((binding) => binding.operationKey === operationKey)
    ))
    && commandSessionLive,
  )
  const entries = standing ? [] : bindings.flatMap((binding): ExecutorEntry[] => {
    // Connected-browser operations stay unavailable until their private-run
    // disclosure gate lands. In particular, their session must never be
    // exposed through an isolated browser, coding, or command entry.
    if (binding.session?.profile === 'connected_browser') return []
    const browserSessionBinding = binding.operationKey === 'browser.open'
      || binding.operationKey === 'browser.observe'
      || binding.operationKey === 'browser.act'
      || (
        binding.operationKey === 'sandbox.stop'
        && binding.session?.profile === 'workspace_sandbox'
        && hasBrowserActionBinding
      )
    const commandSessionBinding = binding.operationKey === 'command.run'
      || (binding.operationKey === 'workspace.review' && binding.session?.profile === 'workspace_sandbox')
      || (
        binding.operationKey === 'sandbox.stop'
        && binding.session?.profile === 'workspace_sandbox'
        && hasExactCommandBundle
      )
    const codingSessionBinding = binding.session?.profile === 'coding_session'
    if (browserSessionBinding && !hasExactBrowserBundle) {
      return []
    }
    if (codingSessionBinding && !hasExactCodingBundle) return []
    if (commandSessionBinding && !hasExactCommandBundle) return []
    if (binding.session?.profile === 'coding_session'
      && binding.session.status === 'attention'
      && binding.operationKey === 'coding.launch') return []
    const registryId = logicalTools.get(binding.operationKey as never)
    const bridgeNames = codingBridgeNames(binding.capabilityRevision?.descriptor)
    const mcpServers = reviewedMcpServers(binding.capabilityRevision?.descriptor)
      .filter((server) => !bridgeNames.has(server))
    const descriptor = descriptorFor(binding.operationKey, { mcpServers })
    if (!registryId || input.agentToolPolicy?.[registryId] !== true || !descriptor) return []
    return [{
      bindingId: binding.id,
      codingBridgeNames: bridgeNames,
      codingSessionsServer: reviewedCodingSessionsServer(binding.capabilityRevision?.descriptor),
      descriptor,
      mcpServers,
      operationKey: binding.operationKey,
      sessionId: binding.session?.id ?? null,
      sessionProfile: binding.session?.profile ?? null,
      toolName: descriptor.toolName,
    }]
  }).sort((left, right) => compareToolName(left.toolName, right.toolName))
  const entryByName = new Map(entries.map((entry) => [entry.toolName, entry]))
  // The ToolCall each provider call's command is recorded under, known before
  // the command exists, so a backstop that gives up on a dispatch still names
  // the row it opened. A catalog walk's first page carries the call's own id.
  const recordIdByProviderCall = new Map<string, string>()
  const recordHostOutput = (): void => {
    if (input.hostOutput) input.hostOutput.sink.addHostOutputScope(input.hostOutput.launchScope)
  }
  // A run resumed after its worker died replays the program answers it already
  // had into its window, so a call an earlier execution made on the pair
  // counts as read before this one calls anything.
  const hostOutputBindingIds = bindings
    .filter((binding) => HOST_OUTPUT_OPERATION_KEYS.has(binding.operationKey))
    .map((binding) => binding.id)
  if (input.hostOutput && hostOutputBindingIds.length > 0) {
    const earlier = await prisma.toolCall.count({
      where: { executorBindingId: { in: hostOutputBindingIds }, runId: input.runId },
    })
    if (earlier > 0) recordHostOutput()
  }
  const endRecord = (outputPreview: string) => async (
    toolCallRecordId: string, result: AgenticToolResult, durationMs: number,
  ): Promise<void> => {
    await prisma.toolCall.updateMany({
      where: { id: toolCallRecordId, runId: input.runId },
      data: { durationMs, endedAt: new Date(), outputPreview, success: result.success },
    })
  }
  const catalogs = createExecutorMcpCatalogs({
    endPage: endRecord('A page of the program catalog.'),
    listPage: (args, providerToolCallId) => dispatch(executorToolName('mcp.tools'), args, providerToolCallId),
    mcpServers: () => entryByName.get(executorToolName('mcp.tools'))?.mcpServers ?? [],
  })
  const dispatchCommand = createExecutorCommandDispatch({
    agentId: input.agentId, encryptionSecret, prisma, recordHostOutput, recordIdByProviderCall, runId: input.runId,
  })
  const ticketWork = input.ticketWork ?? null
  // The coding tools reach the bridge over the mcp.call binding itself, which
  // a standing bind pins even though the generic tool is not offered.
  const baseCodingSessions = codingOffer
    ? createExecutorCodingSessions({
      call: (toolName, args, providerToolCallId, options) => dispatchCommand({
        bindingId: codingOffer.bindingId,
        codingSessionsServer: codingOffer.facts.serverName,
        operationKey: 'mcp.call',
        sessionId: null,
        sessionProfile: null,
      }, toolName, args, providerToolCallId, options),
      endRecord: endRecord('A status read of the coding session.'),
      facts: codingOffer.facts,
      ...(ticketWork
        ? {
            descriptors: ticketWorkCodingDescriptors(codingOffer.facts, ticketWork),
            observe: ticketWorkCodingObserver(prisma, ticketWork),
            ticket: true,
            timing: TICKET_WORK_CODING_WAIT_TIMING,
          }
        // A person's own run links each session to its viewer; a ticket's
        // thread is a project room that never names the machine.
        : { executorId: bindings.find((binding) => binding.id === codingOffer.bindingId)?.executorId }),
      ...codingWaitRunChecks(prisma, {
        agentId: input.agentId, runId: input.runId, ...(ticketWork ? { ticketWorkId: ticketWork.workId } : {}),
      }),
    })
    : null
  const codingSessions = baseCodingSessions && ticketWork
    ? ticketWorkCodingSessions(prisma, baseCodingSessions, ticketWork)
    : baseCodingSessions
  // The bridge is not a program the generic pair reaches. Asked for anyway,
  // the model is pointed at its own tools, or told why it has none.
  const bridgeViaGenericPair = (args: Record<string, unknown>): AgenticToolResult => ({
    correctable: true,
    inputSummary: summarizeToolInput(args),
    output: codingSessions
      ? 'This run reaches the coding-sessions bridge through the coding_session_* tools, not through '
        + 'executor_mcp_tools or executor_mcp_call.'
      : 'The coding-sessions bridge is not reachable from this run: coding sessions act as the machine\'s owner, '
        + 'so only a run that person starts on their own private machine can drive them.',
    success: false,
  })
  const reachesBridge = (entry: ExecutorEntry | undefined, server: unknown): boolean =>
    entry !== undefined && typeof server === 'string' && entry.codingBridgeNames.has(server)

  const dispatch: ExecutorToolset['dispatch'] = async (toolName, modelArgs, providerToolCallId) => {
    if (codingSessions && isCodingSessionToolName(toolName)) {
      return codingSessions.execute(toolName, modelArgs, providerToolCallId)
    }
    const entry = entryByName.get(toolName)
    if (!entry && standing) {
      return {
        correctable: true,
        inputSummary: summarizeToolInput(modelArgs),
        output: 'Ticket work may drive only coding sessions on this machine; no other program on it is offered to you.',
        success: false,
      }
    }
    if (!entry) {
      return { correctable: true, inputSummary: summarizeToolInput(modelArgs), output: `Unknown executor tool: ${toolName}`, success: false }
    }
    const args = shapeExecutorToolArguments(
      entry.operationKey,
      entry.descriptor.inputSchema,
      modelArgs,
      catalogs.inputSchemaOf,
    )
    if (HOST_OUTPUT_OPERATION_KEYS.has(entry.operationKey) && reachesBridge(entry, args.server)) {
      return bridgeViaGenericPair(args)
    }
    const outcome = await dispatchCommand(entry, toolName, args, providerToolCallId)
    if (outcome.kind === 'expired') throw new ExecutorUnknownOutcomeError(outcome.toolCallRecordId)
    return outcome.result
  }

  const timeouts = executorToolTimeouts(
    (toolName) => entryByName.get(toolName)?.operationKey
      ?? (codingSessions && isCodingSessionToolName(toolName) ? 'mcp.call' : undefined),
    (providerToolCallId) => recordIdByProviderCall.get(providerToolCallId),
  )
  return {
    codingSessions,
    descriptors: [...entries.map((entry) => entry.descriptor), ...(codingSessions?.descriptors ?? [])],
    dispatch,
    handledNames: new Set([
      ...entries.map((entry) => entry.toolName),
      ...(codingSessions?.descriptors ?? []).map((descriptor) => descriptor.toolName),
    ]),
    mcpCatalog: async (server, providerToolCallId) => (reachesBridge(entryByName.get(executorToolName('mcp.tools')), server)
      ? { failure: bridgeViaGenericPair({ server }) }
      : catalogs.load(server, providerToolCallId)),
    timeoutErrorFor: timeouts.timeoutErrorFor,
    // A wait is ten minutes of reads; its own deadline ends it inside this.
    timeoutMsFor: (toolName) => (codingSessions && toolName === CODING_SESSION_TOOL_NAMES.wait
      ? ticketWork ? TICKET_WORK_CODING_WAIT_TOOL_TIMEOUT_MS : CODING_WAIT_TOOL_TIMEOUT_MS
      : timeouts.timeoutMsFor(toolName)),
  }
}
