import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  BuildMeProjectHandoffRequest,
  ChannelRecord,
  DeepSignalSignalAction,
  DeepSignalSignalActResponse,
  DeepSignalSignalsResponse,
  DeepTestReviewHandoffRequest,
  DeepWaterResearchLaunchRequest,
  DeepWaterResearchRunRecord,
  IntegratedProductResponse,
  IntegrationPluginManifest,
  SetProductTeamEnablementRequest,
  ThreadMessageRecord,
  ThreadRecord,
} from '../../lib/api-client'
import { useApiClient } from '../../providers/ApiClientProvider'

export const integratedProductsKey = ['integrations', 'products'] as const
export const deepWaterResearchRunsKey =
  ['integrations', 'products', 'deep-water', 'research-runs'] as const
export const deepSignalSignalsKey =
  ['integrations', 'products', 'deepsignal', 'signals'] as const
export const integrationManifestKey = (productSlug?: string) =>
  ['integrations', 'manifest', productSlug ?? 'none'] as const

export const useIntegratedProducts = () => {
  const apiClient = useApiClient()

  return useQuery<IntegratedProductResponse[]>({
    queryKey: integratedProductsKey,
    queryFn: () => apiClient.get('/api/integrations/products'),
  })
}

export const useIntegrationPluginManifest = (productSlug?: string) => {
  const apiClient = useApiClient()

  return useQuery<IntegrationPluginManifest>({
    queryKey: integrationManifestKey(productSlug),
    queryFn: () => apiClient.get(`/api/integrations/products/${productSlug}/manifest`),
    enabled: Boolean(productSlug),
  })
}

// DeepSignal Signals digest (surface-registry plan §4). The route returns a
// discriminated response: `{ status: 'ok', items }` or `{ status: 'needs_setup' }`
// when the connector isn't linked for this user — the page renders the latter as
// a "Connect DeepSignal" empty state rather than an error. `include` toggles
// between the active-only triage view (default) and the full list (with resolved
// signals); both variants cache under the shared prefix so an act invalidates all.
export const useDeepSignalSignals = (include: 'active' | 'all' = 'active') => {
  const apiClient = useApiClient()

  return useQuery<DeepSignalSignalsResponse>({
    queryKey: [...deepSignalSignalsKey, include],
    queryFn: () =>
      apiClient.get(`/api/integrations/products/deepsignal/signals?include=${include}`),
  })
}

// Proxy a done/snooze/mute/reopen action for one insight back to DeepSignal, then
// refetch the digest so the acted-on signal drops out of the active list.
export const useActOnSignal = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation<
    DeepSignalSignalActResponse,
    unknown,
    { insightId: string; action: DeepSignalSignalAction }
  >({
    mutationFn: (input) =>
      apiClient.post(
        `/api/integrations/products/deepsignal/signals/${input.insightId}/act`,
        { action: input.action },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: deepSignalSignalsKey })
    },
  })
}

export const useDeepWaterResearchRuns = () => {
  const apiClient = useApiClient()

  return useQuery<DeepWaterResearchRunRecord[]>({
    queryKey: deepWaterResearchRunsKey,
    queryFn: () => apiClient.get('/api/integrations/products/deep-water/research-runs'),
  })
}

// Response shapes for the external-agent activation endpoints
// (`api/src/routes/integrations/external-agent.ts`). These aren't part of
// `@nessie/schemas` yet — they're validated at the route boundary — so they're
// typed locally here rather than widening the shared client-core surface for two
// fields.
export type ActivateExternalAgentProductResponse = {
  channelId: string
  instanceId: string
  authorizeUrl?: string
}

export type DeactivateExternalAgentProductResponse = {
  channelId: string | null
  instanceId: string | null
}

// Per-user activation is idempotent on the backend: calling it again after a
// fresh OAuth sign-in resolves the now-active instance and flips the account
// link to `linked` without reopening the provider tab, so the same mutation
// both starts and confirms sign-in.
export const useActivateExternalAgentProduct = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (productSlug: string) =>
      apiClient.post<ActivateExternalAgentProductResponse>(
        `/api/integrations/products/${productSlug}/activate`,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: integratedProductsKey })
      void queryClient.invalidateQueries({ queryKey: ['channels'] })
    },
  })
}

export const useDeactivateExternalAgentProduct = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (productSlug: string) =>
      apiClient.post<DeactivateExternalAgentProductResponse>(
        `/api/integrations/products/${productSlug}/deactivate`,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: integratedProductsKey })
      void queryClient.invalidateQueries({ queryKey: ['channels'] })
    },
  })
}

export type ExternalAgentSyncResponse = { imported: number; total: number }

// History hydration for an external-agent channel (DeepSignal §6). Called on
// channel open: pulls turns made on the product's own surfaces into the Nessie
// channel. Idempotent server-side (turnId dedupe), so a repeat open is cheap and
// only invalidates the message list when something new actually landed.
export const useSyncExternalAgentChannel = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { channelId: string; threadId?: string }) =>
      apiClient.post<ExternalAgentSyncResponse>(
        `/api/channels/${input.channelId}/external-sync`,
      ),
    onSuccess: (result, input) => {
      if (result.imported > 0 && input.threadId) {
        void queryClient.invalidateQueries({
          queryKey: ['threads', input.threadId, 'messages'],
        })
      }
    },
  })
}

export const useSetProductTeamEnablement = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (
      input: SetProductTeamEnablementRequest & { productSlug: string },
    ) =>
      apiClient.patch<IntegratedProductResponse>(
        `/api/integrations/products/${input.productSlug}/team-enablement`,
        { enabled: input.enabled },
      ),
    onSuccess: (product) => {
      queryClient.setQueryData<IntegratedProductResponse[]>(
        integratedProductsKey,
        (current) => current?.map((item) => (item.slug === product.slug ? product : item)),
      )
    },
  })
}

export type DeepWaterResearchLaunchResponse = {
  channel: ChannelRecord
  message: ThreadMessageRecord
  run: DeepWaterResearchRunRecord
  thread: ThreadRecord
}

export type IntegrationHandoffResponse = {
  channel: ChannelRecord
  message: ThreadMessageRecord
  thread: ThreadRecord
}

export const useLaunchDeepWaterResearch = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: DeepWaterResearchLaunchRequest) =>
      apiClient.post<DeepWaterResearchLaunchResponse>(
        '/api/integrations/products/deep-water/research-launch',
        input,
      ),
    onSuccess: (response) => {
      queryClient.setQueryData<DeepWaterResearchRunRecord[]>(
        deepWaterResearchRunsKey,
        (current) => {
          const withoutRun = current?.filter((run) => run.id !== response.run.id) ?? []
          return [response.run, ...withoutRun].slice(0, 10)
        },
      )
      void queryClient.invalidateQueries({ queryKey: integratedProductsKey })
      void queryClient.invalidateQueries({ queryKey: deepWaterResearchRunsKey })
      void queryClient.invalidateQueries({ queryKey: ['channels'] })
      void queryClient.invalidateQueries({
        queryKey: ['threads', response.thread.id, 'messages'],
      })
    },
  })
}

export const usePrepareDeepTestReview = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: DeepTestReviewHandoffRequest) =>
      apiClient.post<IntegrationHandoffResponse>(
        '/api/integrations/products/deeptest/security-handoff',
        input,
      ),
    onSuccess: (response) => {
      void queryClient.invalidateQueries({ queryKey: integratedProductsKey })
      void queryClient.invalidateQueries({ queryKey: ['channels'] })
      void queryClient.invalidateQueries({
        queryKey: ['threads', response.thread.id, 'messages'],
      })
    },
  })
}

export const usePrepareBuildMeProjectHandoff = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: BuildMeProjectHandoffRequest) =>
      apiClient.post<IntegrationHandoffResponse>(
        '/api/integrations/products/buildme/project-handoff',
        input,
      ),
    onSuccess: (response) => {
      void queryClient.invalidateQueries({ queryKey: integratedProductsKey })
      void queryClient.invalidateQueries({ queryKey: ['channels'] })
      void queryClient.invalidateQueries({
        queryKey: ['threads', response.thread.id, 'messages'],
      })
    },
  })
}
