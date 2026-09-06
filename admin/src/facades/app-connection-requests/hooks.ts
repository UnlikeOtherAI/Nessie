import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  BeginAppConnectionRequestResponse,
  AppSetupCardPresenter,
} from '@nessie/schemas'

import { appConnectionRequestKeys } from './keys'
import { useApiClient } from '../../providers/ApiClientProvider'

/** The request id is opaque; the server resolves all live, viewer-scoped state. */
export const useAppConnectionRequestCard = (requestId: string | undefined) => {
  const apiClient = useApiClient()

  return useQuery<AppSetupCardPresenter>({
    placeholderData: keepPreviousData,
    queryKey: appConnectionRequestKeys.card(requestId),
    queryFn: () => apiClient.get(`/api/agent-app-connection-requests/${requestId}`),
    enabled: Boolean(requestId),
    // The OAuth callback can return through another browser or a native system
    // session, where there is no shared popup event. The request remains the
    // source of truth; this is only a bounded re-read while it is connecting.
    refetchInterval: (query) => query.state.data?.status === 'connecting' ? 2_000 : false,
  })
}

/** Starts the one card-selected app; the immediate OAuth URL is never cached. */
export const useBeginAppConnectionRequest = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { catalogEntryId: string; requestId: string }) =>
      apiClient.post<BeginAppConnectionRequestResponse>(
        `/api/agent-app-connection-requests/${input.requestId}/begin`,
        { catalogEntryId: input.catalogEntryId },
      ),
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({ queryKey: appConnectionRequestKeys.card(input.requestId) })
    },
  })
}
