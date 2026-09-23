import { randomUUID } from 'node:crypto'

import {
  assertExecutorCommandBindingCurrent,
  createExecutorCommand,
  ensureExecutorLogicalTools,
  EXECUTOR_ERROR_CODES,
  ExecutorError,
  reviewedCodingSessionsServer,
  waitForExecutorCommandResult,
  type ExecutorCommandBindingFacts,
} from '@nessie/executor-manage'
import { ExecutorMcpServerNamesSchema, type ExecutorProfile } from '@nessie/schemas'
import type { PrismaClient } from '@prisma/client'
import type { ToolSchemaDescriptor } from '@nessie/runtime'

import {
  executorCommandTtlMs,
  executorToolTimeouts,
  ExecutorUnknownOutcomeError,
} from './executor-command-timing.js'
import { isCorrectableExecutorFailure } from './executor-correctable-failures.js'
import { HOST_OUTPUT_OPERATION_KEYS, type ExecutorHostOutputDisclosure } from './executor-host-output.js'
import { createExecutorMcpCatalogs, type ExecutorMcpCatalogAnswer } from './executor-mcp-catalog.js'
import { descriptorFor, executorToolName } from './executor-tool-descriptors.js'
import { shapeExecutorToolArguments } from './executor-tool-arguments.js'
import { summarizeToolInput } from './tool-util.js'
import type { AgenticToolResult } from './tools.js'

// The descriptors live in their own module; these names stay importable from here.
export { descriptorFor, executorToolName }

const EXECUTOR_COMMAND_TOPIC = 'executor.command'

type ExecutorEntry = {
  bindingId: string
  /** The reviewed coding-sessions bridge's server name, when the bound revision offers it. */
  codingSessionsServer: string | null
  descriptor: ToolSchemaDescriptor
  mcpServers: readonly string[]
  operationKey: string
  sessionId: string | null
  sessionProfile: ExecutorProfile | null
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
 * What dispatch answers for a terminal result: the raw document, verbatim.
 * Task Set search parses exactly this; the model sees it only after the agent
 * loop's presentation (`executor-result-presentation.ts`).
 */
export const executorDispatchResult = (document: Record<string, unknown>) => ({
  output: JSON.stringify(document),
  success: document.success === true,
  ...(isCorrectableExecutorFailure(document) ? { correctable: true as const } : {}),
})

/**
 * The command payload. A call to the bound revision's coding-sessions bridge
 * carries `owner` — the agent and the person the binding's candidate was made
 * for, never anything the model sent — beside `runId`, under the argument
 * digest, and no other call ever does. The model reaches only `args`: an
 * `owner` it puts there is refused by the daemon's strict envelope, and
 * `_meta` inside `arguments` goes to the program as the program's own.
 */
const executorCommandPayload = (
  entry: ExecutorEntry,
  args: Record<string, unknown>,
  runId: string,
  binding: ExecutorCommandBindingFacts,
): Record<string, unknown> => {
  const bridgeCall = entry.operationKey === 'mcp.call'
    && entry.codingSessionsServer !== null
    && args.server === entry.codingSessionsServer
  return { args, ...(bridgeCall ? { owner: binding.owner } : {}), runId }
}

export type ExecutorToolset = {
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
  },
): Promise<ExecutorToolset> => {
  const encryptionSecret = input.encryptionSecret
  if (!encryptionSecret) {
    const unavailable = { inputSummary: '', output: 'Executor transport is unavailable.', success: false }
    return {
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
        id: true,
        operationKey: true,
        session: { select: { id: true, profile: true, status: true } },
      },
    }),
  ])
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
  const entries = bindings.flatMap((binding): ExecutorEntry[] => {
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
    const mcpServers = reviewedMcpServers(binding.capabilityRevision?.descriptor)
    const descriptor = descriptorFor(binding.operationKey, { mcpServers })
    if (!registryId || input.agentToolPolicy?.[registryId] !== true || !descriptor) return []
    return [{
      bindingId: binding.id,
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
  const catalogs = createExecutorMcpCatalogs({
    endPage: async (toolCallRecordId, result, durationMs) => {
      await prisma.toolCall.updateMany({
        where: { id: toolCallRecordId, runId: input.runId },
        data: { durationMs, endedAt: new Date(), outputPreview: 'A page of the program catalog.', success: result.success },
      })
    },
    listPage: (args, providerToolCallId) => dispatch(executorToolName('mcp.tools'), args, providerToolCallId),
    mcpServers: () => entryByName.get(executorToolName('mcp.tools'))?.mcpServers ?? [],
  })

  const dispatch: ExecutorToolset['dispatch'] = async (toolName, modelArgs, providerToolCallId) => {
    const entry = entryByName.get(toolName)
    if (!entry) {
      return { correctable: true, inputSummary: summarizeToolInput(modelArgs), output: `Unknown executor tool: ${toolName}`, success: false }
    }
    const args = shapeExecutorToolArguments(
      entry.operationKey,
      entry.descriptor.inputSchema,
      modelArgs,
      catalogs.inputSchemaOf,
    )
    // Before the command exists: whatever the program answers, a failure
    // included, is its output, and a catalog page is as much a read as a call.
    if (HOST_OUTPUT_OPERATION_KEYS.has(entry.operationKey)) recordHostOutput()
    const startedAt = new Date()
    const commandId = randomUUID()
    const toolCallRecordId = randomUUID()
    recordIdByProviderCall.set(providerToolCallId, toolCallRecordId)
    const created = await prisma.$transaction(async (tx) => {
      const binding = await assertExecutorCommandBindingCurrent(tx, entry.bindingId, {
        // browser.open is the one transition that consumes its freshly
        // created pending session. Delivery still requires active, so a
        // queued command cannot reopen a stopped browser.
        allowPendingBrowserOpen: entry.operationKey === 'browser.open',
        allowPendingCodingLaunch: entry.operationKey === 'coding.launch',
        allowPendingCommandRun: entry.operationKey === 'command.run',
      })
      if (binding.runId !== input.runId) throw new Error('Executor binding run mismatch.')
      if (binding.sessionId !== entry.sessionId) throw new Error('Executor binding session mismatch.')
      if (
        entry.operationKey === 'browser.open'
        || entry.operationKey === 'coding.launch'
        || entry.operationKey === 'command.run'
      ) {
        if (!binding.sessionId || !entry.sessionProfile) {
          return { sessionUnavailable: entry.sessionProfile ?? 'workspace_sandbox' as const }
        }
        const activated = await tx.executorSession.updateMany({
          where: {
            executorId: binding.executorId,
            id: binding.sessionId,
            profile: entry.sessionProfile,
            runId: input.runId,
            status: 'pending',
          },
          data: { status: 'active' },
        })
        if (activated.count !== 1) return { sessionUnavailable: entry.sessionProfile }
      }
      if (
        entry.operationKey === 'browser.observe'
        || entry.operationKey === 'browser.act'
        || (entry.sessionProfile === 'workspace_sandbox' && entry.operationKey === 'workspace.review')
        || (entry.sessionProfile === 'coding_session' && (
          entry.operationKey === 'coding.observe' || entry.operationKey === 'workspace.review'
        ))
      ) {
        if (!binding.sessionId || !entry.sessionProfile) {
          return { sessionUnavailable: entry.sessionProfile ?? 'workspace_sandbox' as const }
        }
        const active = await tx.executorSession.findFirst({
          where: {
            executorId: binding.executorId,
            id: binding.sessionId,
            profile: entry.sessionProfile,
            runId: input.runId,
            status: entry.sessionProfile === 'coding_session'
              ? { in: ['active', 'attention'] }
              : 'active',
          },
          select: { id: true },
        })
        if (!active) return { sessionUnavailable: entry.sessionProfile }
      }
      if (entry.operationKey === 'sandbox.stop' && binding.sessionId) {
        await tx.executorSession.updateMany({
          where: {
            executorId: binding.executorId,
            id: binding.sessionId,
            ...(entry.sessionProfile ? { profile: entry.sessionProfile } : {}),
            runId: input.runId,
            status: { in: ['pending', 'active', 'attention', 'detached'] },
          },
          data: { status: 'stopped' },
        })
      }
      const toolCall = await tx.toolCall.create({
        data: {
          id: toolCallRecordId,
          agentId: input.agentId,
          inputSummary: summarizeToolInput(args),
          runId: input.runId,
          startedAt,
          toolName,
          executorBindingId: entry.bindingId,
        },
        select: { id: true },
      })
      const queueJob = await tx.queueJob.create({
        data: {
          idempotencyKey: `executor-command:${input.runId}:${providerToolCallId}`,
          payload: { commandId },
          status: 'pending',
          topic: EXECUTOR_COMMAND_TOPIC,
        },
        select: { id: true },
      })
      const expiresAt = new Date(startedAt.getTime() + executorCommandTtlMs(entry.operationKey))
      await createExecutorCommand(tx, {
        bindingId: entry.bindingId,
        commandId,
        encryptionSecret,
        expiresAt,
        payload: executorCommandPayload(entry, args, input.runId, binding),
        queueJobId: queueJob.id,
        toolCallId: toolCall.id,
      })
      return { expiresAt, toolCallId: toolCall.id }
    }).catch((error: unknown) => {
      // The coding-sessions rule refused the call where its command is made:
      // the lane's own refusal, in words the model can pass on to the person.
      if (error instanceof ExecutorError && error.code === EXECUTOR_ERROR_CODES.CODING_SESSIONS_OWNER_ONLY) {
        return { refused: { code: error.code, message: error.message, success: false } }
      }
      throw error
    })
    if ('refused' in created) {
      return { inputSummary: summarizeToolInput(args), ...executorDispatchResult(created.refused) }
    }
    if ('sessionUnavailable' in created) {
      return {
        inputSummary: summarizeToolInput(args),
        output: created.sessionUnavailable === 'coding_session'
          ? 'The coding session is no longer available for this run.'
          : 'The browser session is no longer available for this run.',
        success: false,
      }
    }
    const result = await waitForExecutorCommandResult(
      prisma,
      encryptionSecret,
      commandId,
      created.expiresAt,
    )
    if (!result) throw new ExecutorUnknownOutcomeError(created.toolCallId)
    return {
      inputSummary: summarizeToolInput(args),
      ...executorDispatchResult(result),
      toolCallRecordId: created.toolCallId,
    }
  }

  return {
    descriptors: entries.map((entry) => entry.descriptor),
    dispatch,
    handledNames: new Set(entries.map((entry) => entry.toolName)),
    mcpCatalog: catalogs.load,
    ...executorToolTimeouts(
      (toolName) => entryByName.get(toolName)?.operationKey,
      (providerToolCallId) => recordIdByProviderCall.get(providerToolCallId),
    ),
  }
}

export { EXECUTOR_COMMAND_TOPIC }
