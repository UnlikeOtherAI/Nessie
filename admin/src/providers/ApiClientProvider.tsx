import { useMemo, type PropsWithChildren } from 'react'
import { ApiClientProvider as CoreApiClientProvider, useApiClient } from '@nessie/client-core'
import { createApiClient } from '../lib/api-client'
import { useAuthSession } from './AuthSessionProvider'

export const ApiClientProvider = ({ children }: PropsWithChildren) => {
  const { token, refreshAccessToken } = useAuthSession()
  const client = useMemo(
    () => createApiClient(token, refreshAccessToken),
    [token, refreshAccessToken],
  )

  return <CoreApiClientProvider client={client}>{children}</CoreApiClientProvider>
}

export { useApiClient }
