import type { ProviderMessage } from '@nessie/runtime'

/**
 * These labels name the adapter that turned a source into a provider-visible
 * component. They deliberately stay out of the provider payload: a host gets
 * model input, never a description of the material that produced it.
 */
export type ProviderInputSourceAdapter =
  | 'admitted_checkpoint'
  | 'assistant_output'
  | 'compaction'
  | 'conversation'
  | 'direct_prompt'
  | 'generated_utility'
  | 'global_catalogue'
  | 'loop_instruction'
  | 'memory'
  // The assistant turn a pressed card button's prepared call stands in for
  // (`prepared-card-call.ts`): written by the agent when it posted the card.
  | 'prepared_action'
  | 'prompt_system'
  | 'secret_redaction'
  // The turn after a tool batch that carries the images its results named
  // (`tool-images.ts`): tool output on a user turn, never the person.
  | 'tool_images'
  | 'tool_result'
  | 'wind_down'

export type ProviderInputFinalization =
  | { kind: 'ready'; providerInput: ProvenancedProviderInput }
  | { kind: 'unclassified_input' }

type Coverage = {
  adapter: ProviderInputSourceAdapter
  token: object
}

const componentCoverage = Symbol('localInferenceProviderInputCoverage')
const providerInputIssuer = Symbol('localInferenceProviderInputIssuer')

type CoveredProviderMessage = ProviderMessage & {
  [componentCoverage]?: Coverage
}

const deepFreeze = <Value>(value: Value): Value => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/** A sealed, dispatchable provider input. It cannot be object-literal forged. */
export class ProvenancedProviderInput {
  readonly #messages: ProviderMessage[]

  constructor(issuer: symbol, messages: ProviderMessage[]) {
    if (issuer !== providerInputIssuer) throw new Error('Provider input issuance is restricted.')
    this.#messages = deepFreeze(structuredClone(messages))
    Object.freeze(this)
  }

  read(issuer: symbol): ProviderMessage[] | null {
    return issuer === providerInputIssuer ? this.#messages : null
  }
}

/**
 * Source adapters call this at the moment their component enters a prompt.
 * The token is intentionally process-local and opaque: raw provider objects
 * cannot self-attest after an adapter forgot to cover them.
 */
export const coverProviderInputComponent = <Message extends ProviderMessage>(
  message: Message,
  adapter: ProviderInputSourceAdapter,
): Message => {
  if (coverageFor(message)) return message
  Object.defineProperty(message, componentCoverage, {
    configurable: false,
    enumerable: false,
    value: { adapter, token: Object.freeze({}) },
    writable: false,
  })
  return message
}

const coverageFor = (message: ProviderMessage): Coverage | undefined =>
  (message as CoveredProviderMessage)[componentCoverage]

/**
 * A pure transformation (redaction or legacy-note normalization) may retain
 * coverage only when its exact input was already covered. It cannot turn an
 * unclassified component into an authorised one.
 */
export const deriveProviderInputComponent = <Message extends ProviderMessage>(
  source: ProviderMessage,
  message: Message,
  adapter: ProviderInputSourceAdapter,
): Message => coverageFor(source)
  ? coverProviderInputComponent(message, adapter)
  : message

/**
 * The same, for a transformation that only takes images off a covered turn
 * (the prompt's image budget, a model that cannot see them): the turn keeps
 * the adapter it was admitted under.
 */
export const retainProviderInputComponent = <Message extends ProviderMessage>(
  source: ProviderMessage,
  message: Message,
): Message => {
  const coverage = coverageFor(source)
  return coverage ? coverProviderInputComponent(message, coverage.adapter) : message
}

/** Cover a generated utility prompt at its single construction boundary. */
export const coverGeneratedUtilityInput = (
  messages: ProviderMessage[],
): ProviderMessage[] => messages.map((message) =>
  coverProviderInputComponent(message, 'generated_utility'))

/**
 * Compaction is allowed to create a new transcript only from a wholly covered
 * source transcript. A failed source check deliberately leaves its output
 * unmarked, so the next local call reports `unclassified_input`.
 */
export const coverCompactedProviderInput = (
  source: ProviderMessage[],
  compacted: ProviderMessage[],
): ProviderMessage[] => source.length > 0 && source.every((message) => coverageFor(message))
  ? compacted.map((message) => coverProviderInputComponent(message, 'compaction'))
  : compacted

/**
 * Finalization compares every ordered component with a distinct adapter token.
 * In particular, an empty message list never becomes an implicit public-only
 * proof, and reusing one covered object in two positions is rejected.
 */
export const finalizeProvenancedProviderInput = (
  messages: ProviderMessage[],
): ProviderInputFinalization => {
  if (messages.length === 0) return { kind: 'unclassified_input' }
  const coverageTokens = new Set<object>()
  for (const message of messages) {
    const coverage = coverageFor(message)
    if (!coverage || !coverage.adapter || !coverage.token || coverageTokens.has(coverage.token)) {
      return { kind: 'unclassified_input' }
    }
    coverageTokens.add(coverage.token)
  }
  if (coverageTokens.size !== messages.length) return { kind: 'unclassified_input' }

  const providerInput = new ProvenancedProviderInput(providerInputIssuer, messages)
  return { kind: 'ready', providerInput }
}

/** Opens only a handle issued by the finalizer; callers receive frozen bytes. */
export const openProvenancedProviderInput = (
  input: ProvenancedProviderInput,
): ProviderMessage[] | null => input instanceof ProvenancedProviderInput
  ? input.read(providerInputIssuer)
  : null
