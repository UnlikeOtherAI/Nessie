import type { ProviderMessage } from '@nessie/runtime'
import { redactDetectedSecrets } from '@nessie/schemas'

/**
 * Keep detected secrets out of the transcript the loop retains.
 *
 * A tool call's arguments are replayed to the provider on every later turn of
 * the same run, so a credential the model put in one — `http_fetch({ body:
 * 'api_key=…' })` — is re-sent unredacted for the rest of the run even though
 * the surrounding text is masked. Strings are scanned wherever they sit in the
 * argument object.
 *
 * The retained transcript is also what a crash checkpoint persists, so this is
 * what keeps a raw credential out of `run_checkpoints.crash_state` as well.
 */
const redactArgumentStrings = (value: unknown): unknown => {
  if (typeof value === 'string') return redactDetectedSecrets(value)
  if (Array.isArray(value)) return value.map(redactArgumentStrings)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, nested]) => [key, redactArgumentStrings(nested)]),
    )
  }
  return value
}

const redactToolCalls = (message: ProviderMessage): ProviderMessage => {
  if (!('toolCalls' in message) || !message.toolCalls) return message
  return {
    ...message,
    toolCalls: message.toolCalls.map((call) => ({
      ...call,
      arguments: redactArgumentStrings(call.arguments) as Record<string, unknown>,
    })),
  } as ProviderMessage
}

export const redactMessageContent = (message: ProviderMessage): ProviderMessage => {
  const withSafeCalls = redactToolCalls(message)
  if (typeof withSafeCalls.content !== 'string') return withSafeCalls
  return {
    ...withSafeCalls,
    content: redactDetectedSecrets(withSafeCalls.content),
  } as ProviderMessage
}
