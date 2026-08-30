import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ChatAssistantSurface } from '@nessie/schemas'
import type {
  BuildMeProjectHandoffRequest,
  ChannelRecord,
  DeepSignalSignalAction,
  DeepSignalSignalActResponse,
  DeepSignalSignalsResponse,
  DeepTestReviewHandoffRequest,
  DeepWaterAgentAccessResponse,
  DeepWaterResearchLaunchRequest,
  DeepWaterResearchRunRecord,
  IntegratedProductResponse,
  IntegrationPluginManifest,
  SetDeepWaterAgentAccessRequest,
  SetProductTeamEnablementRequest,
  ThreadMessageRecord,
  ThreadRecord,
} from '../../lib/api-client'
import { useIsOwner } from '../../components/shared/OwnerGate'
import { useApiClient } from '../../providers/ApiClientProvider'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import {
  channelKeys,
  deepSignalSignalsKey,
  deepSignalSignalsKeyPrefix,
  deepWaterAgentAccessKey,
  deepWaterAgentAccessKeyPrefix,
  deepWaterResearchRunsKey,
  deepWaterResearchRunsKeyPrefix,
  integratedProductsKey,
  integratedProductsKeyPrefix,
  integrationManifestKey,
  mcpKeys,
  threadKeys,
  toolPolicyTargetsKeyPrefix,
  type IntegrationQueryScope,
} from '../../lib/query-keys'
import { isExternalAgentChannel } from '../personal-assistant/hooks'

const useIntegrationQueryScope = (): IntegrationQueryScope | null => {
  const { me } = useAuthSession()
  const isOwner = useIsOwner()
  return me
    ? {
        isOwner,
        organizationId: me.context.organizationId,
        teamId: me.context.teamId,
        userId: me.user.id,
      }
    : null
}

export const useIntegratedProducts = () => {
  const apiClient = useApiClient()
  const scope = useIntegrationQueryScope()

  return useQuery<IntegratedProductResponse[]>({
    queryKey: scope
      ? integratedProductsKey(scope)
      : [...integratedProductsKeyPrefix, 'signed-out'],
    queryFn: () => apiClient.get('/api/integrations/products'),
    enabled: scope !== null,
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

// Function-first identity + conversation starters for an external-agent DM,
// sourced entirely from the product's plugin manifest so a second external agent
// needs no code change here. The external-agent channel carries no product slug,
// but its label is the product name, so we resolve the product (and thus its
// manifest) by matching on that — the same join the sidebar uses.
export type ExternalAgentIdentity = {
  productSlug: string
  name: string
  description: string | null
  iconGlyph: string | null
  conversationStarters: string[]
}

export const useExternalAgentIdentity = (
  channel: ChannelRecord | null | undefined,
): ExternalAgentIdentity | null => {
  const isExternal = isExternalAgentChannel(channel)
  const productsQuery = useIntegratedProducts()
  const product = isExternal
    ? productsQuery.data?.find((entry) => entry.name === channel?.label)
    : undefined
  const manifestQuery = useIntegrationPluginManifest(product?.slug)

  return useMemo(() => {
    if (!isExternal || !product || !manifestQuery.data) {
      return null
    }
    const manifest = manifestQuery.data
    const chat = manifest.surfaces.find(
      (surface): surface is ChatAssistantSurface => surface.type === 'chat_assistant',
    )
    return {
      productSlug: product.slug,
      name: chat?.label ?? product.name,
      description: chat?.description ?? (product.summary || null),
      iconGlyph: chat?.iconGlyph ?? null,
      conversationStarters: manifest.conversationStarters ?? [],
    }
  }, [isExternal, product, manifestQuery.data])
}

// DeepSignal Signals digest (surface-registry plan §4). The route returns a
// discriminated response: `{ status: 'ok', items }` or `{ status: 'needs_setup' }`
// when the connector isn't linked for this user — the page renders the latter as
// a "Connect DeepSignal" empty state rather than an error. `include` toggles
// between the active-only triage view (default) and the full list (with resolved
// signals); both variants cache under the shared prefix so an act invalidates all.
export const useDeepSignalSignals = (include: 'active' | 'all' = 'active') => {
  const apiClient = useApiClient()
  const scope = useIntegrationQueryScope()

  return useQuery<DeepSignalSignalsResponse>({
    queryKey: scope
      ? deepSignalSignalsKey(scope, include)
      : [...deepSignalSignalsKeyPrefix, 'signed-out', include],
    queryFn: () =>
      apiClient.get(`/api/integrations/products/deepsignal/signals?include=${include}`),
    enabled: scope !== null,
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
      void queryClient.invalidateQueries({
        queryKey: deepSignalSignalsKeyPrefix,
      })
    },
  })
}

export const useDeepWaterResearchRuns = () => {
  const apiClient = useApiClient()
  const scope = useIntegrationQueryScope()

  return useQuery<DeepWaterResearchRunRecord[]>({
    queryKey: scope
      ? deepWaterResearchRunsKey(scope)
      : [...deepWaterResearchRunsKeyPrefix, 'signed-out'],
    queryFn: () => apiClient.get('/api/integrations/products/deep-water/research-runs'),
    enabled: scope !== null,
  })
}

export const useDeepWaterAgentAccess = (enabled = true) => {
  const apiClient = useApiClient()
  const scope = useIntegrationQueryScope()

  return useQuery<DeepWaterAgentAccessResponse>({
    queryKey: scope
      ? deepWaterAgentAccessKey(scope)
      : [...deepWaterAgentAccessKeyPrefix, 'signed-out'],
    queryFn: () =>
      apiClient.get('/api/integrations/products/deep-water/agent-access'),
    enabled: enabled && scope !== null,
  })
}

export const useSetDeepWaterAgentAccess = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: SetDeepWaterAgentAccessRequest) =>
      apiClient.patch<DeepWaterAgentAccessResponse>(
        '/api/integrations/products/deep-water/agent-access',
        input,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: deepWaterAgentAccessKeyPrefix,
      })
      void queryClient.invalidateQueries({
        queryKey: toolPolicyTargetsKeyPrefix,
      })
    },
  })
}

// Response shapes for the external-agent activation endpoints
// (`api/src/routes/integrations/external-agent.ts`). These aren't part of
// `@nessie/schemas` yet — they're validated at the route boundary — so they're
// typed locally here rather than widening the shared client-core surface for
// this small response.
export type ActivateExternalAgentProductResponse = {
  channelId: string
  instanceId: string
}

export type DeactivateExternalAgentProductResponse = {
  channelId: string | null
  instanceId: string | null
}

// Per-user activation is idempotent on the backend and reuses the UOA identity
// already linked by Nessie's own SSO session.
export const useActivateExternalAgentProduct = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (productSlug: string) =>
      apiClient.post<ActivateExternalAgentProductResponse>(
        `/api/integrations/products/${productSlug}/activate`,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: integratedProductsKeyPrefix,
      })
      void queryClient.invalidateQueries({ queryKey: channelKeys.all })
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
      void queryClient.invalidateQueries({
        queryKey: integratedProductsKeyPrefix,
      })
      void queryClient.invalidateQueries({ queryKey: channelKeys.all })
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
          queryKey: threadKeys.messages(input.threadId),
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
      void queryClient.invalidateQueries({
        queryKey: integratedProductsKeyPrefix,
      })
      if (product.slug === 'deep-water') {
        void queryClient.invalidateQueries({
          queryKey: deepWaterAgentAccessKeyPrefix,
        })
        void queryClient.invalidateQueries({
          queryKey: toolPolicyTargetsKeyPrefix,
        })
        void queryClient.invalidateQueries({
          queryKey: mcpKeys.tools,
        })
      }
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
      void queryClient.invalidateQueries({
        queryKey: integratedProductsKeyPrefix,
      })
      void queryClient.invalidateQueries({
        queryKey: deepWaterResearchRunsKeyPrefix,
      })
      void queryClient.invalidateQueries({ queryKey: channelKeys.all })
      void queryClient.invalidateQueries({
        queryKey: threadKeys.messages(response.thread.id),
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
      void queryClient.invalidateQueries({
        queryKey: integratedProductsKeyPrefix,
      })
      void queryClient.invalidateQueries({ queryKey: channelKeys.all })
      void queryClient.invalidateQueries({
        queryKey: threadKeys.messages(response.thread.id),
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
      void queryClient.invalidateQueries({
        queryKey: integratedProductsKeyPrefix,
      })
      void queryClient.invalidateQueries({ queryKey: channelKeys.all })
      void queryClient.invalidateQueries({
        queryKey: threadKeys.messages(response.thread.id),
      })
    },
  })
}
