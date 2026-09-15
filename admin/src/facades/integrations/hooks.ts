import { useMemo } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ChatAssistantSurface } from '@nessie/schemas'
import type {
  ChannelRecord,
  DeepWaterAgentAccessResponse,
  DeepWaterResearchLaunchRequest,
  DeepWaterResearchRunRecord,
  IntegratedProductResponse,
  IntegrationPluginManifest,
  ThreadMessageRecord,
  ThreadRecord,
} from '../../lib/api-client'
import { useIsOwner } from '../auth/hooks'
import { useApiClient } from '../../providers/ApiClientProvider'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { channelKeys } from '../channels/keys'
import { threadKeys } from '../threads/keys'
import {
  deepWaterAgentAccessKey,
  deepWaterAgentAccessKeyPrefix,
  deepWaterResearchRunsKey,
  deepWaterResearchRunsKeyPrefix,
  integratedProductsKey,
  integratedProductsKeyPrefix,
  integrationManifestKey,
  type IntegrationQueryScope,
} from './keys'
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
    placeholderData: keepPreviousData,
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

export type DeepWaterResearchLaunchResponse = {
  channel: ChannelRecord
  message: ThreadMessageRecord
  run: DeepWaterResearchRunRecord
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
