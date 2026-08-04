import type {
  ConnectorRegistry,
  ModelProviderConfig,
  ModelProviderName,
  ProviderConnector,
} from '../types.js'
import { createKimiConnector } from './kimi.js'
import { createMiniMaxConnector } from './minimax.js'
import { createOpenAiLikeConnector } from './openai.js'

export const createConnectorRegistry = (): ConnectorRegistry => {
  const factories = new Map<
    ModelProviderName,
    (config: ModelProviderConfig) => ProviderConnector
  >([
    ['minimax', createMiniMaxConnector],
    ['kimi', createKimiConnector],
    ['deepseek', (config) => createOpenAiLikeConnector('deepseek', {
      ...config,
      baseUrl: config.baseUrl ?? 'https://api.deepseek.com/v1',
    })],
    ['openai', (config) => createOpenAiLikeConnector('openai', config)],
    [
      'openai-compatible',
      (config) => createOpenAiLikeConnector('openai-compatible', config),
    ],
  ])

  return {
    getConfigured(config: ModelProviderConfig): ProviderConnector {
      const factory = factories.get(config.provider)
      if (!factory) {
        throw new Error(`No provider connector is registered for ${config.provider}`)
      }

      return factory(config)
    },

    listRegistered() {
      return Array.from(factories.keys())
    },

    register(
      provider: ModelProviderName,
      factory,
    ): void {
      factories.set(provider, factory)
    },
  }
}
