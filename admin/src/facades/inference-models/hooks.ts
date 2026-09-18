import { useMutation, useQueryClient } from '@tanstack/react-query'

import { agentKeys } from '../agents/keys'
import { inferenceModelKeys } from './keys'
import { usePagedList } from '../pagination/usePagedList'
import { useApiClient } from '../../providers/ApiClientProvider'

/**
 * The deployment's model catalogue as an organisation owner governs it.
 *
 * The list is **Ledger's**, read live per request, with this organisation's own
 * enable/disable decisions folded in — so a row may have no local database
 * identity at all, and a Ledger that cannot be read is an error state rather
 * than a stale list. Personal model subscriptions are deliberately absent: an
 * organisation owner has no standing over somebody's own consumer plan
 * (docs/standards/personal-model-subscriptions.md).
 */

export type DeploymentModelRecord = {
  /** Agents in this organisation currently pinned to this exact pair. */
  agentCount: number
  description?: string
  displayName: string
  enabled: boolean
  /** False means "no local decision yet" — the Ledger default applies. */
  hasLocalDecision: boolean
  model: string
  provider: string
  providerDisplayName: string
}

export type InferenceModelTestResult = {
  failure?: { code: string; message: string }
  latencyMs: number
  model: string
  ok: boolean
  provider: string
  reply?: string
}

export const useDeploymentModelCatalog = (enabled: boolean) =>
  usePagedList<DeploymentModelRecord>({
    enabled,
    path: '/api/inference/model-catalog',
    queryKey: inferenceModelKeys.catalog,
  })

export const useSetDeploymentModelEnabled = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { enabled: boolean; model: string; provider: string }) =>
      apiClient.patch<DeploymentModelRecord>('/api/inference/model-catalog', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: inferenceModelKeys.all })
      // The Agent Designer's picker is the same decision seen from the other
      // side: a pair switched off here must stop being offerable there without
      // a reload.
      void queryClient.invalidateQueries({ queryKey: agentKeys.models })
    },
  })
}

/**
 * Send one real prompt to one exact pair.
 *
 * The call is billed — it is an ordinary inference call carrying the owner's
 * own attribution — and a provider refusal comes back as a *result* with the
 * provider's own words, never as a thrown error, so the page can tell a bad key
 * from a retired model from a timeout.
 */
export const useTestDeploymentModel = () => {
  const apiClient = useApiClient()

  return useMutation({
    mutationFn: (input: { model: string; provider: string }) =>
      apiClient.post<InferenceModelTestResult>('/api/inference/models/test', input),
  })
}
