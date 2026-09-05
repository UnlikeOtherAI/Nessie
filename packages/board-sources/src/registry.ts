import type { BoardSourceAdapter, BoardSourceProvider } from './adapter.js'
import { AdapterNotRegisteredError } from './errors.js'

/**
 * Adapters register a factory at startup from `NESSIE_BOARD_*` env, exactly as
 * the communications connectors do. A provider with no configuration on this
 * deployment stays unregistered: the connect picker never offers it, and any
 * job that names it parks on `AdapterNotRegisteredError` rather than failing
 * in a way that looks like an outage.
 */

export type BoardSourceAdapterFactory = () => BoardSourceAdapter

const registry = new Map<BoardSourceProvider, BoardSourceAdapterFactory>()

export const registerBoardSourceAdapter = (
  provider: BoardSourceProvider,
  factory: BoardSourceAdapterFactory,
): void => {
  registry.set(provider, factory)
}

export const hasBoardSourceAdapter = (provider: BoardSourceProvider): boolean =>
  registry.has(provider)

export const listRegisteredProviders = (): BoardSourceProvider[] => [...registry.keys()]

export const resolveBoardSourceAdapter = (
  provider: BoardSourceProvider,
): BoardSourceAdapter => {
  const factory = registry.get(provider)
  if (!factory) throw new AdapterNotRegisteredError(provider)
  return factory()
}

/** Registered adapters that ask for a periodic incremental sweep. */
export const listPollingAdapters = (): Array<{
  provider: BoardSourceProvider
  intervalMs: number
}> =>
  [...registry.entries()].flatMap(([provider, factory]) => {
    const intervalMs = factory().incrementalPollingIntervalMs
    return typeof intervalMs === 'number' && Number.isFinite(intervalMs) && intervalMs > 0
      ? [{ provider, intervalMs }]
      : []
  })

/** Test and bootstrap helper: forget every registration. */
export const clearBoardSourceAdapters = (): void => {
  registry.clear()
}
