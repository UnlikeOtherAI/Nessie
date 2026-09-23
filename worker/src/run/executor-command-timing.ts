import {
  EXECUTOR_MCP_COMMAND_TTL_MS,
  EXECUTOR_TOOL_TIMEOUT_MARGIN_MS,
} from '@nessie/schemas'

import { EXECUTOR_MCP_CATALOG_MAX_PAGES } from './executor-mcp-catalog.js'
import { FatalToolExecutionError } from './tool-execution-errors.js'

// File operations and the other bounded daemon reads and writes.
const COMMAND_TTL_MS = 25_000
// Guest startup includes a bounded initrd build and VM handshake before the
// browser request itself; the ordinary file-operation timeout is too short.
const BROWSER_COMMAND_TTL_MS = 3 * 60 * 1_000
// Command execution is bounded at five minutes locally; keep its delivery
// lease long enough for that runtime and VM startup, not the session teardown.
const COMMAND_RUN_TTL_MS = 6 * 60 * 1_000

/**
 * How long a command for this operation may take, measured from the moment
 * the worker creates it. When it expires without a result the command is an
 * unknown outcome.
 */
export const executorCommandTtlMs = (operationKey: string): number => {
  switch (operationKey) {
    case 'browser.open':
    case 'browser.observe':
    case 'browser.act':
    case 'coding.launch':
      return BROWSER_COMMAND_TTL_MS
    case 'command.run':
      return COMMAND_RUN_TTL_MS
    // A local program's start, its call and its uploads, plus the lane's own
    // hops; the sum and its inequality live in `@nessie/schemas`.
    case 'mcp.tools':
    case 'mcp.call':
      return EXECUTOR_MCP_COMMAND_TTL_MS
    default:
      return COMMAND_TTL_MS
  }
}

/**
 * The tool batch's own timeout for an executor tool. It sits a margin past the
 * command's TTL, so the TTL is what normally ends a slow command and this is
 * only the backstop for a dispatch that stops making progress at all.
 */
export const executorToolTimeoutMs = (operationKey: string): number =>
  executorCommandTtlMs(operationKey) + EXECUTOR_TOOL_TIMEOUT_MARGIN_MS

/**
 * An executor command nobody saw finish: its TTL expired, or the batch's
 * backstop timeout fired first. Either way the command may still complete on
 * the machine, so the error is fatal — the run is requeued and its replay
 * answers the call as an unknown outcome instead of repeating a side effect. A
 * plain retriable "timed out" would invite the model to send it twice.
 *
 * `toolCallRecordId` names the durable ToolCall the command was recorded under,
 * so whoever catches this can end that row rather than open a second one. It
 * is absent only when no command was ever started for the call.
 */
export class ExecutorUnknownOutcomeError extends FatalToolExecutionError {
  constructor(readonly toolCallRecordId?: string) {
    super('Executor command outcome is unknown.')
  }
}

/**
 * A toolset's two timeout answers, given how it maps its own tool names to
 * operation keys: undefined (and null) for any name it does not offer.
 *
 * `recordIdOf` names the ToolCall a call's command was recorded under, so the
 * backstop's unknown outcome ends that row instead of the batch opening a
 * second one beside it.
 */
export const executorToolTimeouts = (
  operationKeyOf: (toolName: string) => string | undefined,
  recordIdOf: (providerToolCallId: string) => string | undefined = () => undefined,
) => ({
  timeoutErrorFor: (toolName: string, providerToolCallId?: string): Error | null =>
    operationKeyOf(toolName) === undefined
      ? null
      : new ExecutorUnknownOutcomeError(providerToolCallId === undefined ? undefined : recordIdOf(providerToolCallId)),
  timeoutMsFor: (toolName: string): number | undefined => {
    const operationKey = operationKeyOf(toolName)
    if (operationKey === undefined) return undefined
    // The agent loop answers `executor_mcp_tools` with a catalog walk: up to
    // that many `mcp.tools` commands one after another, each on its own TTL
    // and each waiting its turn in the machine's one command lane. One
    // command's backstop would fire before a second page's own TTL did.
    return operationKey === 'mcp.tools'
      ? executorToolTimeoutMs(operationKey) * EXECUTOR_MCP_CATALOG_MAX_PAGES
      : executorToolTimeoutMs(operationKey)
  },
})
