import { useMemo, type PropsWithChildren } from 'react'
import { ApiClientProvider as CoreApiClientProvider, useApiClient } from '@nessie/client-core'
import { createApiClient } from '../lib/api-client'
import { useAuthSession } from './AuthSessionProvider'

export const ApiClientProvider = ({ children }: PropsWithChildren) => {
  const { token, refreshAccessToken, sessionMode } = useAuthSession()
  const client = useMemo(
    () => createApiClient(
      token,
      () => refreshAccessToken({ mode: sessionMode, token }),
    ),
    [refreshAccessToken, sessionMode, token],
  )

  return <CoreApiClientProvider client={client}>{children}</CoreApiClientProvider>
}

export { useApiClient }
