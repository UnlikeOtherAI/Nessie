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

const defaultQueryClient = createQueryClient()

export type QueryProviderProps = PropsWithChildren<{
  // Optional override; defaults to a shared client with Nessie's standard
  // query/mutation defaults.
  client?: QueryClient
}>

export const QueryProvider = ({ client = defaultQueryClient, children }: QueryProviderProps) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
)
