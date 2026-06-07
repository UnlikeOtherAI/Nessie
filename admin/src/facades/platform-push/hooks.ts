import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  PushApnsEnvironment,
  PushCredentialResult,
  PushProvider,
  PushStatusResponse,
  PushTestResult,
} from '@nessie/schemas'
import { putMultipart } from '../../lib/multipart'
import { useApiClient } from '../../providers/ApiClientProvider'
import { useAuthSession } from '../../providers/AuthSessionProvider'

const STATUS_QUERY_KEY = ['platform-push', 'status'] as const

export const usePushStatus = (enabled = true) => {
  const apiClient = useApiClient()

  return useQuery<PushStatusResponse>({
    enabled,
    queryKey: STATUS_QUERY_KEY,
    queryFn: () => apiClient.get('/api/platform/push/status'),
  })
}

export type UploadApnsInput = {
  file: File
  keyId?: string
  teamId: string
  topic: string
  environment?: PushApnsEnvironment
}

export const useUploadApns = () => {
  const { token } = useAuthSession()
  const queryClient = useQueryClient()

  return useMutation<PushCredentialResult, Error, UploadApnsInput>({
    mutationFn: ({ file, keyId, teamId, topic, environment }) => {
      const fields: Record<string, string> = { teamId, topic }
      if (keyId) fields.keyId = keyId
      if (environment) fields.environment = environment
      return putMultipart('/api/platform/push/apns', file, fields, token)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY })
    },
  })
}

export const useUploadFcm = () => {
  const { token } = useAuthSession()
  const queryClient = useQueryClient()

  return useMutation<PushCredentialResult, Error, { file: File }>({
    mutationFn: ({ file }) =>
      putMultipart('/api/platform/push/fcm', file, {}, token),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY })
    },
  })
}

export const useTestPush = () => {
  const apiClient = useApiClient()

  return useMutation<PushTestResult, Error, { provider: PushProvider; deviceToken?: string }>({
    mutationFn: (input) => apiClient.post('/api/platform/push/test', input),
  })
}

export const useDeletePushCredential = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation<PushCredentialResult, Error, PushProvider>({
    mutationFn: (provider) => apiClient.delete(`/api/platform/push/${provider}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY })
    },
  })
}
