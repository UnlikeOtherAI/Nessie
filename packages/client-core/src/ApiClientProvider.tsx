import { createContext, useContext, type PropsWithChildren } from 'react'
import type { ApiClient } from './api-client.js'

const ApiClientContext = createContext<ApiClient | null>(null)

export type ApiClientProviderProps = PropsWithChildren<{
  // Host app constructs the concrete client (with its resolved base URL and
  // current token) and supplies it here.
  client: ApiClient
}>

export const ApiClientProvider = ({ client, children }: ApiClientProviderProps) => (
  <ApiClientContext.Provider value={client}>{children}</ApiClientContext.Provider>
)

export const useApiClient = (): ApiClient => {
  const context = useContext(ApiClientContext)
  if (!context) {
    throw new Error('useApiClient must be used within ApiClientProvider')
  }

  return context
}
