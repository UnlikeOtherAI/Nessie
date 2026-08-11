import type { ModelProviderConfig } from './types.js'
import { DEFAULT_EMBEDDING_MODEL } from './connectors/openai-chat-protocol.js'

/**
 * Deployment configuration for embeddings, when they must not follow chat.
 *
 * Chat and embeddings are separate capabilities that happen to share a client.
 * A deployment routing chat at DeepSeek has no embeddings endpoint at all
 * (Ledger answers `embeddings is not allowed for deepseek`), so the embedding
 * destination has to be nameable on its own. Every field is optional: unset
 * fields inherit the chat provider, and an override with nothing set leaves the
 * embedding path exactly as it was.
 */
export type EmbeddingProviderOverride = {
  provider?: ModelProviderConfig['provider']
  apiKey?: string
  baseUrl?: string
  modelName?: string
  serviceId?: string
}

export type ResolvedEmbeddingProvider = {
  /**
   * The provider to embed against, or null when the override names no separate
   * destination — then embeddings ride the chat connector, as they always have.
   */
  config: ModelProviderConfig | null
  /** The model every embed call asks for. Never the chat model. */
  model: string
}

const trimmed = (value: string | undefined): string | undefined => {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

/**
 * Fold an embedding override onto the chat provider config.
 *
 * `serviceId` is resolved explicitly rather than left to default, because the
 * default is "the provider's own name" — right for `openai`, meaningless for
 * `openai-compatible`, and the whole point of the override when Ledger fronts a
 * provider it does not name after the connector protocol (Jina speaks the
 * OpenAI embeddings shape but lives at `/v1/jina`).
 */
export const resolveEmbeddingProvider = (
  chat: ModelProviderConfig,
  override: EmbeddingProviderOverride | undefined,
): ResolvedEmbeddingProvider => {
  const provider = trimmed(override?.provider) as
    | ModelProviderConfig['provider']
    | undefined
  const apiKey = trimmed(override?.apiKey)
  const baseUrl = trimmed(override?.baseUrl)
  const serviceId = trimmed(override?.serviceId)
  const model = trimmed(override?.modelName) ?? DEFAULT_EMBEDDING_MODEL

  // A model name alone changes what is asked for, not where it is asked. Only a
  // provider, key, URL, or service segment makes a second destination.
  if (!provider && !apiKey && !baseUrl && !serviceId) {
    return { config: null, model }
  }

  return {
    config: {
      apiKey: apiKey ?? chat.apiKey,
      baseUrl: baseUrl ?? chat.baseUrl,
      modelName: model,
      provider: provider ?? chat.provider,
      serviceId: serviceId ?? provider ?? chat.serviceId ?? chat.provider,
    },
    model,
  }
}

/**
 * Whether two inference base URLs address the same host, which is what decides
 * whether a credential minted for one may travel to the other. Path is
 * deliberately ignored: Ledger's `/v1/jina` and `/v1/deepseek` are two adapters
 * on one authenticated service, not two parties. Unparseable or absent URLs
 * count as the same only when both are absent, so an unreadable value never
 * silently earns the caller's identity.
 */
export const isSameInferenceHost = (
  left: string | undefined,
  right: string | undefined,
): boolean => {
  if (!left || !right) return !left && !right
  try {
    return new URL(left).origin === new URL(right).origin
  } catch {
    return false
  }
}
