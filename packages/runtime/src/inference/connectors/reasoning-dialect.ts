import type { ModelProviderName } from '../types.js'

/**
 * How a chat/completions endpoint is asked to think, and what it needs back.
 *
 * Every OpenAI-compatible endpoint Nessie talks to reports its reasoning under
 * nearly the same contract (`delta.reasoning_content`, or `delta.reasoning`
 * on OpenRouter), but the request side genuinely differs:
 *
 * - **DeepSeek** (`api.deepseek.com`, directly or through Ledger's `deepseek`
 *   service) thinks by default, is switched with `thinking.type`, documents
 *   `max_tokens` only, and — once a request carries `tools` — answers 400
 *   unless every assistant turn's `reasoning_content` is passed back.
 * - **DashScope** (Alibaba Cloud Model Studio, Ledger's `alibaba` service) is
 *   switched with `enable_thinking`. Its hybrid models default either way, so
 *   the switch is always sent; thinking is stream-only there ("must be set to
 *   false for non-streaming calls") and incompatible with JSON mode.
 * - **OpenAI and everything OpenAI-shaped** (OpenRouter, xAI, Z.ai…) take
 *   `reasoning_effort` alone, and OpenAI rejects a message carrying an
 *   unknown `reasoning_content` field.
 *
 * The dialect is resolved once per connector from the provider and the Ledger
 * service id — never from a caller, a stored record, or a model — and applied
 * at the transport boundary, so the raw `fetchCompletion` escape hatch the
 * Designer uses is covered by the same rule as `invoke` and `stream`.
 *
 * Thinking is requested only where a person can see it: a streamed, non-JSON
 * turn feeds the run's thought log; a silent utility call (compaction,
 * delegate, JSON extraction) runs in the provider's non-thinking mode, which
 * is also the only mode DashScope serves without a stream.
 */
export type ReasoningDialect = 'openai' | 'deepseek' | 'dashscope'

const DASHSCOPE_SERVICE_ID = 'alibaba'

export const resolveReasoningDialect = (input: {
  provider: ModelProviderName
  serviceId?: string
}): ReasoningDialect => {
  const serviceId = input.serviceId?.trim().toLowerCase()
  if (input.provider === 'deepseek' || serviceId === 'deepseek') return 'deepseek'
  if (serviceId === DASHSCOPE_SERVICE_ID) return 'dashscope'
  return 'openai'
}

/** Thinking is asked for only on a turn whose thoughts can be shown. */
export const requestWantsVisibleReasoning = (
  body: Record<string, unknown>,
): boolean => body.stream === true && body.response_format === undefined

type WireMessage = Record<string, unknown>

const withoutReplayedReasoning = (messages: unknown): unknown => {
  if (!Array.isArray(messages)) return messages
  return messages.map((message: unknown) => {
    if (
      typeof message !== 'object'
      || message === null
      || (message as WireMessage).role !== 'assistant'
      || !('reasoning_content' in (message as WireMessage))
    ) {
      return message
    }
    const rest: WireMessage = { ...(message as WireMessage) }
    Reflect.deleteProperty(rest, 'reasoning_content')
    return rest
  })
}

const withDeepSeekOutputCap = (body: Record<string, unknown>): Record<string, unknown> => {
  const maxCompletionTokens = body.max_completion_tokens
  const maxTokens = body.max_tokens
  const rest = { ...body }
  Reflect.deleteProperty(rest, 'max_completion_tokens')
  Reflect.deleteProperty(rest, 'max_tokens')
  return {
    ...rest,
    ...(typeof maxTokens === 'number'
      ? { max_tokens: maxTokens }
      : typeof maxCompletionTokens === 'number'
        ? { max_tokens: maxCompletionTokens }
        : {}),
  }
}

/**
 * Normalise one chat/completions body for its dialect. Pure: the caller's body
 * is never mutated, and a field the dialect owns (`thinking`,
 * `enable_thinking`) is always the dialect's decision, never the caller's.
 */
export const applyReasoningDialect = (
  dialect: ReasoningDialect,
  body: Record<string, unknown>,
): Record<string, unknown> => {
  const visible = requestWantsVisibleReasoning(body)
  if (dialect === 'deepseek') {
    const rest = withDeepSeekOutputCap(body)
    Reflect.deleteProperty(rest, 'thinking')
    return { ...rest, thinking: { type: visible ? 'enabled' : 'disabled' } }
  }
  if (dialect === 'dashscope') {
    return { ...body, enable_thinking: visible }
  }
  return body.messages === undefined
    ? body
    : { ...body, messages: withoutReplayedReasoning(body.messages) }
}
