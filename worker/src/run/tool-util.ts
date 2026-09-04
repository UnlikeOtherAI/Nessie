import { createHash } from 'node:crypto'
import { redactDetectedSecrets } from '@nessie/schemas'
import type { ProviderToolCall } from '@nessie/runtime'

import type { AgenticToolResult, ToolExecutionUsage, AgentCardSuspension } from './tool-types.js'

// --- Tool result size budget -------------------------------------------------
//
// Every tool result the model sees is re-billed on each later iteration, so an
// oversized result is not paid once but once per remaining turn. The caps below
// keep the discovery tools within one order of magnitude of each other: when
// `web_search`/`web_fetch` self-capped at 1,200 chars while a raw `http_fetch`
// body rode the 32,000-char chokepoint, the 26× gap taught the model to reach
// for the bulky tool.

/**
 * Default cap for a "content" tool's result text — `web_search`, `web_fetch`
 * and `document_read` in `content-tools.ts` all truncate through this.
 */
export const MAX_PREVIEW_LENGTH = 4_000

/**
 * Cap for a raw HTTP/API response body (`http_fetch`, and the HTTP transport in
 * `tool-http.ts`). Large enough for a real API payload, small enough that a
 * handful of them cannot dominate the context window.
 */
export const MAX_RAW_BODY_CHARS = 12_000

/** Final chokepoint: applied to every tool result before it enters context. */
export const MAX_TOOL_RESULT_CHARS = 32_000

export const truncate = (value: string, maxLength = MAX_PREVIEW_LENGTH): string =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`

// Marker embedded in any tool result that overflows a cap. The explicit
// dropped-character count tells the model the result is partial (so it can
// request the rest instead of assuming it saw everything), and the distinctive
// bracketed form lets a second pass detect an already-truncated string and skip
// re-truncating it — the loop re-applies this at the point results enter
// context, on top of the per-tool caps in `tools.ts`.
const TOOL_RESULT_TRUNCATION_MARKER = /\n\n\[\.\.\. truncated \d+ chars \.\.\.\]\n\n/

// Middle-out: the head carries a result's shape (headers, schema, the first
// records) and the tail carries how it ends (totals, the closing brace, the
// last log lines). A tail-only cut silently discards the second half, which is
// exactly where "did it finish?" lives.
const TRUNCATION_HEAD_SHARE = 0.7

export const truncateToolResult = (
  output: string,
  maxChars = MAX_TOOL_RESULT_CHARS,
): string => {
  // Tool results are both model context and durable ToolCall previews. Apply
  // the structural scanner before either sink, at the same shared chokepoint
  // that already bounds every builtin, MCP and delegated result.
  const redacted = redactDetectedSecrets(output)
  if (redacted.length <= maxChars) return redacted
  if (TOOL_RESULT_TRUNCATION_MARKER.test(redacted)) return redacted
  const removed = redacted.length - maxChars
  const headChars = Math.floor(maxChars * TRUNCATION_HEAD_SHARE)
  const tailChars = maxChars - headChars
  const head = redacted.slice(0, headChars)
  const tail = tailChars > 0 ? redacted.slice(redacted.length - tailChars) : ''
  return `${head}\n\n[... truncated ${removed} chars ...]\n\n${tail}`
}

/**
 * Run one builtin tool and settle it into an `AgenticToolResult`. A thrown
 * `Error` becomes a failed result carrying its message, which is how every
 * builtin reports a refusal or a bad argument to the model.
 */
export const wrapTool = async (
  inputSummary: string,
  fn: () => Promise<{
    connectorUsage?: ToolExecutionUsage
    outputPreview: string
    pendingInput?: AgentCardSuspension
  }>,
): Promise<AgenticToolResult> => {
  try {
    const result = await fn()
    return {
      connectorUsage: result.connectorUsage,
      inputSummary,
      output: truncateToolResult(result.outputPreview),
      // Only a successful post may suspend the run: a card nobody can see is
      // not something to wait on.
      ...(result.pendingInput ? { pendingInput: result.pendingInput } : {}),
      success: true,
    }
  } catch (error) {
    return {
      inputSummary,
      output: 'Tool error: ' + (error instanceof Error ? error.message : String(error)),
      success: false,
    }
  }
}

const SECRET_KEY_PATTERN =
  new RegExp(
    [
      'api[_-]?key',
      'authorization',
      'bearer',
      'client[_-]?secret',
      'contentBase64',
      'credential',
      'password',
      'private[_-]?key',
      'refresh[_-]?token',
      'secret',
      'token',
    ].join('|'),
    'i',
  )

const REDACTED = '[REDACTED]'
export type SanitizedProviderToolCall = ProviderToolCall & {
  secretArgumentBlocked?: true
}

const normalizedToolArgumentKey = (key: string): string =>
  key.replace(/([a-z\d])([A-Z])/gu, '$1_$2').toLowerCase()

const toolArgumentKeyIsSecret = (key: string): boolean => {
  const compact = normalizedToolArgumentKey(key).replace(/[\s._-]/gu, '')
  return compact.endsWith('token')
    || compact.endsWith('password')
    || compact.endsWith('passphrase')
    || compact.endsWith('credential')
    || compact.endsWith('secret')
    || [
      'apikey',
      'authorization',
      'bearer',
      'credentialvalue',
      'pin',
      'privatekey',
      'secretaccesskey',
      'secretkey',
      'secretvalue',
    ].includes(compact)
}

export type SanitizedToolArguments = {
  detected: boolean
  value: Record<string, unknown>
}

const redactToolArgumentSecrets = (
  value: unknown,
  key = '',
  depth = 0,
): { detected: boolean; value: unknown } => {
  // A shape deeper than the bounded walk is itself refused. Returning
  // `detected: false` here used to make the caller restore the original,
  // uninspected argument tree.
  if (depth > 8) return { detected: true, value: '[MaxDepth]' }
  if (key && toolArgumentKeyIsSecret(key) && value !== null) {
    return { detected: true, value: '[REDACTED_SECRET]' }
  }
  if (typeof value === 'string') {
    const redacted = redactDetectedSecrets(value)
    return { detected: redacted !== value, value: redacted }
  }
  if (value === null || typeof value !== 'object') return { detected: false, value }

  let detected = false
  if (Array.isArray(value)) {
    const entries = value.map((entry) => {
      const result = redactToolArgumentSecrets(entry, key, depth + 1)
      detected ||= result.detected
      return result.value
    })
    return { detected, value: entries }
  }

  const entries: Record<string, unknown> = {}
  for (const [entryKey, entry] of Object.entries(value as Record<string, unknown>)) {
    const result = redactToolArgumentSecrets(entry, entryKey, depth + 1)
    detected ||= result.detected
    entries[entryKey] = result.value
  }
  return { detected, value: entries }
}

export const sanitizeToolArguments = (
  value: Record<string, unknown>,
): SanitizedToolArguments => {
  const result = redactToolArgumentSecrets(value)
  return {
    detected: result.detected,
    value: result.value as Record<string, unknown>,
  }
}

/**
 * Provider-created arguments are context, approval state, demonstrations, and
 * potentially external side effects. Replace any credential-shaped value and
 * mark the call so orchestration can refuse execution without persisting raw
 * arguments or sending a corrupted credential to a tool.
 */
export const sanitizeProviderToolCalls = (
  toolCalls: ProviderToolCall[],
): SanitizedProviderToolCall[] => toolCalls.map((toolCall) => {
  const result = sanitizeToolArguments(toolCall.arguments)
  if (!result.detected) return toolCall
  return {
    ...toolCall,
    arguments: result.value as Record<string, unknown>,
    secretArgumentBlocked: true,
  }
})

export const redactToolInputValue = (value: unknown, depth = 0): unknown => {
  if (depth > 8) return '[MaxDepth]'
  if (typeof value === 'string') return redactDetectedSecrets(value)
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return value.map((entry) => redactToolInputValue(entry, depth + 1))
  }

  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = toolArgumentKeyIsSecret(key) || SECRET_KEY_PATTERN.test(key)
      ? REDACTED
      : redactToolInputValue(entry, depth + 1)
  }
  return out
}

export const summarizeToolInput = (value: unknown, maxLength = 200): string => {
  try {
    return redactDetectedSecrets(
      JSON.stringify(redactToolInputValue(value)),
    ).slice(0, maxLength)
  } catch {
    return '[Unserializable tool input]'
  }
}

export const stableJsonStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonStringify(entry)).join(',')}]`
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  )
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJsonStringify(entry)}`)
    .join(',')}}`
}

export const hashJsonValue = (value: unknown): string =>
  createHash('sha256').update(stableJsonStringify(value)).digest('hex')
