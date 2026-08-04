import type {
  CapabilityCatalog,
  CapabilityResolution,
  ConnectorRegistry,
  ModelProviderConfig,
} from './types.js'

const DEFAULT_MODELS: Record<ModelProviderConfig['provider'], string> = {
  minimax: 'MiniMax-M2.5',
  kimi: 'kimi-for-coding',
  deepseek: 'deepseek-v4-flash',
  openai: 'gpt-5-mini',
  'openai-compatible': 'gpt-5-mini',
}

const capabilityCacheKey = (
  config: ModelProviderConfig,
  model: string,
): string => `${config.provider}:${config.baseUrl ?? ''}:${model}`

export const createCapabilityCatalog = (
  registry: ConnectorRegistry,
): CapabilityCatalog => {
  const cache = new Map<string, CapabilityResolution>()

  return {
    invalidate(provider, model) {
      if (model) {
        for (const key of cache.keys()) {
          if (key.startsWith(`${provider}:`) && key.endsWith(`:${model}`)) {
            cache.delete(key)
          }
        }
        return
      }

      for (const key of cache.keys()) {
        if (key.startsWith(`${provider}:`)) {
          cache.delete(key)
        }
      }
    },

    async resolve(
      config: ModelProviderConfig,
      model = config.modelName,
    ): Promise<CapabilityResolution> {
      const resolvedModel = model ?? config.modelName ?? DEFAULT_MODELS[config.provider]
      const key = capabilityCacheKey(config, resolvedModel)
      const cached = cache.get(key)
      if (cached) {
        return cached
      }

      const connector = registry.getConfigured(config)
      const effectiveSnapshot = await connector.getModelCapabilities(resolvedModel)
      const resolution: CapabilityResolution = {
        effectiveSnapshot,
        effectiveSource: 'static',
        overrideActive: false,
      }

      cache.set(key, resolution)
      return resolution
    },
  }
}
