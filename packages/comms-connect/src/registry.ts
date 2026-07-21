import type { CommunicationsConnector } from './connector.js'
import type { CommsProviderId } from './provider.js'

/**
 * Thrown when a sync/webhook path asks for a provider that has no registered
 * connector. Typed so the worker can distinguish "not wired up yet" (skip
 * cleanly, mark the job failed with a clear reason) from a genuine runtime
 * fault.
 */
export class ConnectorNotRegisteredError extends Error {
  readonly provider: CommsProviderId

  constructor(provider: CommsProviderId) {
    super(`No communications connector registered for provider "${provider}"`)
    this.name = 'ConnectorNotRegisteredError'
    this.provider = provider
  }
}

/**
 * A factory that lazily builds a connector. Provider adapters register a
 * factory at module load; the worker resolves one per job. Kept as a factory
 * (not a singleton instance) so adapters can pull request-scoped dependencies
 * when they are implemented.
 */
export type ConnectorFactory = () => CommunicationsConnector

const registry = new Map<CommsProviderId, ConnectorFactory>()

export const registerConnector = (
  provider: CommsProviderId,
  factory: ConnectorFactory,
): void => {
  registry.set(provider, factory)
}

export const hasConnector = (provider: CommsProviderId): boolean =>
  registry.has(provider)

export const resolveConnector = (
  provider: CommsProviderId,
): CommunicationsConnector => {
  const factory = registry.get(provider)
  if (!factory) {
    throw new ConnectorNotRegisteredError(provider)
  }
  return factory()
}

/** Test/bootstrap helper: forget all registrations. */
export const clearConnectors = (): void => {
  registry.clear()
}
