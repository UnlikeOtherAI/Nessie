import { createContext, useContext, useMemo, type PropsWithChildren } from 'react'
import { createApiClient, type ApiClient } from '../lib/api-client'
import { useAuthSession } from './AuthSessionProvider'

const ApiClientContext = createContext<ApiClient | null>(null)

export const ApiClientProvider = ({ children }: PropsWithChildren) => {
  const { token } = useAuthSession()
  const client = useMemo(() => createApiClient(token), [token])

  return <ApiClientContext.Provider value={client}>{children}</ApiClientContext.Provider>
}

export const useApiClient = (): ApiClient => {
  const context = useContext(ApiClientContext)
  if (!context) {
    throw new Error('useApiClient must be used within ApiClientProvider')
  }

  return context
}
