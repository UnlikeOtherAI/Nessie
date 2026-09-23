/**
 * Executor failures the model fixes by changing its call.
 *
 * They go back to the model like any other failure, and they never count
 * toward the circuit breaker: a malformed argument, an answer too large for the
 * lane or a tool name the server does not have says nothing about whether the
 * program works, and three of them in a row used to disable every tool the
 * program offers.
 */

// The daemon's own refusals, each of which names what to change.
const CORRECTABLE_CODES: ReadonlySet<string> = new Set([
  'EXECUTOR_COMMAND_ARGUMENTS_INVALID',
  'EXECUTOR_MCP_CURSOR_INVALID',
  'EXECUTOR_MCP_RESULT_TOO_LARGE',
])

// The server refusing the call before its tool ran. An MCP SDK server answers
// an unknown tool name, and arguments that fail the tool's input schema, with
// JSON-RPC Invalid Params (-32602) and hands it back as an `isError` result,
// which the daemon forwards as `EXECUTOR_MCP_CALL_FAILED` with the server's
// own text. An output-schema failure carries the same code and is the
// program's fault, so it is deliberately not matched.
const SERVER_REFUSAL = /^MCP error -32602: (?:Tool .+ not found|Input validation error: )/

const firstText = (content: unknown): string | null => {
  if (!Array.isArray(content)) return null
  const first: unknown = content[0]
  if (typeof first !== 'object' || first === null) return null
  const item = first as { text?: unknown; type?: unknown }
  return item.type === 'text' && typeof item.text === 'string' ? item.text : null
}

export const isCorrectableExecutorFailure = (result: Record<string, unknown>): boolean => {
  if (result.success === true) return false
  if (typeof result.code === 'string' && CORRECTABLE_CODES.has(result.code)) return true
  if (result.code !== 'EXECUTOR_MCP_CALL_FAILED' || result.isError !== true) return false
  const text = firstText(result.content)
  return text !== null && SERVER_REFUSAL.test(text)
}
