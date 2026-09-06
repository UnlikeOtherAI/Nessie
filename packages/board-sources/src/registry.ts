import type {
  BoardSourceAdapter,
  BoardSourceAuthMethodKind,
  BoardSourceProvider,
  CredentialForm,
} from './adapter.js'
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
  // An adapter with neither method is unreachable: nothing could ever connect
  // it, and it would sit in the picker as a dead end with a nice label. Caught
  // here, at startup, rather than as an empty dialog much later.
  const { auth } = factory()
  if (!auth.oauth && !auth.apiKey) {
    throw new Error(`[board-sources] ${provider} declares no way to authenticate`)
  }
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

/**
 * What the connect picker needs to draw itself: which ways in this provider
 * offers on this deployment, and the form to render for a pasted credential.
 * Read from the adapter's own declaration — no surface guesses.
 */
export type BoardSourceProviderMethods = {
  provider: BoardSourceProvider
  methods: BoardSourceAuthMethodKind[]
  apiKeyForm: CredentialForm | null
}

export const listProviderMethods = (): BoardSourceProviderMethods[] =>
  [...registry.entries()].map(([provider, factory]) => {
    const { auth } = factory()
    return {
      provider,
      methods: [
        ...(auth.apiKey ? (['api_key'] as const) : []),
        ...(auth.oauth ? (['oauth'] as const) : []),
      ],
      apiKeyForm: auth.apiKey?.form ?? null,
    }
  })

/** Test and bootstrap helper: forget every registration. */
export const clearBoardSourceAdapters = (): void => {
  registry.clear()
}
