import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Mutation } from '@tanstack/react-query'
import type { PropsWithChildren } from 'react'

export type CreateQueryClientOptions = {
  /**
   * The floor, not an override: called when a mutation rejects and the
   * mutation itself declared no `onError` of its own. A per-mutation
   * `onError` always wins — this only catches the ones nobody wired a
   * failure surface for. Additive: omitting it (desktop, mobile) leaves the
   * client exactly as it was before this option existed.
   */
  onMutationError?: (error: unknown, mutation: Mutation<unknown, unknown, unknown>) => void
}

export const createQueryClient = (options: CreateQueryClientOptions = {}): QueryClient => {
  const { onMutationError } = options

  return new QueryClient({
    mutationCache: onMutationError
      ? new MutationCache({
        onError: (error, _variables, _onMutateResult, mutation) => {
          if (mutation.options.onError) return
          onMutationError(error, mutation)
        },
      })
      : undefined,
    defaultOptions: {
      mutations: {
        retry: 0,
      },
      queries: {
        refetchOnWindowFocus: false,
        retry: 1,
        staleTime: 5 * 60 * 1000,
      },
    },
  })
}

// The default app-wide client for a host that mounts `<QueryProvider>` with no
// `client` prop (desktop, mobile). Exported for the rare imperative caller
// that needs the cache outside a component's provider tree — e.g. the
// pull-to-refresh content refresh, which fires from the navigation layer
// where no provider is guaranteed in isolation. The admin builds its own
// client (`admin/src/providers/QueryProvider.tsx`) with `onMutationError`
// wired to its toast surface, so it passes `client` explicitly instead.
export const sharedQueryClient = createQueryClient()

export type QueryProviderProps = PropsWithChildren<{
  // Optional override; defaults to the shared client above with Nessie's
  // standard query/mutation defaults.
  client?: QueryClient
}>

export const QueryProvider = ({ client = sharedQueryClient, children }: QueryProviderProps) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
)
