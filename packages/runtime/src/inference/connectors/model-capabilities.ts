import type { ModelCapabilitySnapshot } from '../types.js'
import { nowIso } from './connector-invocations.js'

export const createBaseSnapshot = (input: {
  discoveredAt?: string
  model: string
  provider: ModelCapabilitySnapshot['provider']
  supportsEmbeddings: boolean
  supportsVision: boolean
  structuredOutputMode: ModelCapabilitySnapshot['structuredOutputMode']
  systemPromptMode: ModelCapabilitySnapshot['systemPromptMode']
  toolCallingMode: ModelCapabilitySnapshot['toolCallingMode']
  toolResultMode: ModelCapabilitySnapshot['toolResultMode']
}): ModelCapabilitySnapshot => {
  const discoveredAt = input.discoveredAt ?? nowIso()

  return {
    discoveredAt,
    lastVerifiedAt: discoveredAt,
    model: input.model,
    provider: input.provider,
    source: 'static',
    structuredOutputMode: input.structuredOutputMode,
    supportsChat: true,
    supportsEmbeddings: input.supportsEmbeddings,
    supportsModelDiscovery: false,
    supportsStreaming: true,
    supportsVision: input.supportsVision,
    systemPromptMode: input.systemPromptMode,
    toolCallingMode: input.toolCallingMode,
    toolResultMode: input.toolResultMode,
    usageReporting: {
      cacheReadTokens: false,
      cacheWriteTokens: false,
      cachedInputTokens: false,
      cachedOutputTokens: false,
      inputTokens: true,
      outputTokens: true,
      providerReportedCost: false,
    },
  }
}
