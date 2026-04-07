import type { NessieConfig } from './schema.js'

export type RuntimeCapabilities = {
  hasRedis: boolean
  hasObjectStorage: boolean
  hasExternalAuth: boolean
  hasPubSub: boolean
}

export function deriveRuntimeCapabilities(config: NessieConfig): RuntimeCapabilities {
  return {
    hasRedis: Boolean(config.redis?.enabled && config.redis.url),
    hasObjectStorage: config.storage.provider !== 'filesystem',
    hasExternalAuth:
      config.auth.providers.some((provider) => provider.enabled && provider.type !== 'local-bootstrap'),
    hasPubSub: config.queue.provider === 'pubsub',
  }
}
