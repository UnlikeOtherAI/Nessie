import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PropsWithChildren } from 'react'

export const createQueryClient = (): QueryClient =>
  new QueryClient({
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

// The one app-wide client the admin mounts (QueryProvider takes no `client`
// prop, so this instance backs every `useQueryClient()`). Exported for the rare
// imperative caller that needs the cache outside a component's provider tree —
// e.g. the pull-to-refresh content refresh, which fires from the navigation
// layer where no provider is guaranteed in isolation.
export const sharedQueryClient = createQueryClient()

export type QueryProviderProps = PropsWithChildren<{
  // Optional override; defaults to the shared client above with Nessie's
  // standard query/mutation defaults.
  client?: QueryClient
}>

export const QueryProvider = ({ client = sharedQueryClient, children }: QueryProviderProps) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
)
