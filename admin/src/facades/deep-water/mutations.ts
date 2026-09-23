import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  DeepWaterBriefViewSchema,
  DeepWaterResearchRunViewSchema,
  type CreateDeepWaterBriefRequest,
  type DeepWaterBriefReplyRequest,
  type DeepWaterBriefView,
  type DeepWaterResearchRunView,
  type IntegratedProductResponse,
  type StartDeepWaterBriefRequest,
} from '@nessie/schemas'
import { useApiClient } from '../../providers/ApiClientProvider'
import { appKeys } from '../apps/keys'
import { deepWaterAgentAccessKeyPrefix, integratedProductsKeyPrefix } from '../integrations/keys'
import { RESEARCH_RUNS_PATH, researchRunPath, useDeepWaterViewerScope } from './hooks'
import { deepWaterKeys } from './keys'

/**
 * Every person action on a DeepWater research (nessie.md §7.1). The API
 * records the action and hands it to the worker, answering 202 with the new
 * state; what DeepWater makes of it arrives later through the realtime
 * refetch. Each request carries an `actionId`: the caller mints one per
 * intent and sends the same id again when it retries that intent after an
 * ambiguous failure, which the server answers as a replay rather than a second
 * planner turn. A new intent — including "send it again" after the planner
 * failed — is a new id.
 */

/** A fresh idempotency key for one person action. */
export const newResearchActionId = (): string => crypto.randomUUID()

const parse = <T>(schema: { parse: (value: unknown) => T }, value: unknown): T => schema.parse(value)

export const useCreateResearchBrief = () => {
  const api = useApiClient()
  const queryClient = useQueryClient()
  const scope = useDeepWaterViewerScope()
  return useMutation({
    mutationFn: async (input: CreateDeepWaterBriefRequest): Promise<DeepWaterBriefView> =>
      parse(DeepWaterBriefViewSchema, await api.post(RESEARCH_RUNS_PATH, input)),
    onSuccess: (brief) => {
      if (scope) queryClient.setQueryData(deepWaterKeys.brief(brief.id, scope), brief)
      void queryClient.invalidateQueries({ queryKey: deepWaterKeys.lists })
    },
  })
}

/** A reply to DeepWater's planner, carrying any edits to the pillars and settings. */
export const useReplyToResearchBrief = (runId: string) => {
  const api = useApiClient()
  const queryClient = useQueryClient()
  const scope = useDeepWaterViewerScope()
  return useMutation({
    mutationFn: async (input: DeepWaterBriefReplyRequest): Promise<DeepWaterBriefView> =>
      parse(DeepWaterBriefViewSchema, await api.post(`${researchRunPath(runId)}/messages`, input)),
    onSuccess: (brief) => {
      if (scope) queryClient.setQueryData(deepWaterKeys.brief(runId, scope), brief)
      void queryClient.invalidateQueries({ queryKey: deepWaterKeys.run(runId) })
    },
  })
}

/** Start the research on the brief agreed at `revision`, with any last edits. */
export const useStartResearchBrief = (runId: string) => {
  const api = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: StartDeepWaterBriefRequest): Promise<DeepWaterResearchRunView> =>
      parse(DeepWaterResearchRunViewSchema, await api.post(`${researchRunPath(runId)}/start`, input)),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: deepWaterKeys.run(runId) })
      void queryClient.invalidateQueries({ queryKey: deepWaterKeys.lists })
    },
  })
}

/**
 * Cancel a brief or a running research — the requester's own, or, for a team
 * owner or admin, any open research in the team (amendments N8.5). A viewer who
 * may not read the run gets only its id and status back.
 */
export const useCancelResearchRun = () => {
  const api = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { actionId: string; runId: string }) =>
      api.post<unknown>(`${researchRunPath(input.runId)}/cancel`, { actionId: input.actionId }),
    onSettled: (_result, _error, input) => {
      void queryClient.invalidateQueries({ queryKey: deepWaterKeys.run(input.runId) })
      void queryClient.invalidateQueries({ queryKey: deepWaterKeys.lists })
    },
  })
}

/** Try delivering a finished research again after a retryable block ("Retry import"). */
export const useRetryResearchDelivery = () => {
  const api = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { actionId: string; runId: string }): Promise<DeepWaterResearchRunView> =>
      parse(
        DeepWaterResearchRunViewSchema,
        await api.post(`${researchRunPath(input.runId)}/deliver`, { actionId: input.actionId }),
      ),
    onSettled: (_result, _error, input) => {
      void queryClient.invalidateQueries({ queryKey: deepWaterKeys.run(input.runId) })
    },
  })
}

/**
 * An owner turning DeepWater on or off for the team. Turning it on again is
 * also how a team on an older tool contract is updated in place. The server
 * refuses a change that would strand an open research (409, naming the run).
 */
export const useSetDeepWaterTeamEnabled = () => {
  const api = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (enabled: boolean) =>
      api.patch<IntegratedProductResponse>(
        '/api/integrations/products/deep-water/team-enablement',
        { enabled },
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: integratedProductsKeyPrefix })
      void queryClient.invalidateQueries({ queryKey: deepWaterAgentAccessKeyPrefix })
      void queryClient.invalidateQueries({ queryKey: appKeys.all })
    },
  })
}
