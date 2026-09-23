import { useMutation, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { ApiClientError } from '@nessie/client-core'
import {
  DEEP_WATER_BRIEF_ERROR_CODES,
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
 *
 * Every answer is read through its schema by the client itself, so an answer
 * that does not match the contract fails as `INVALID_RESPONSE` — an action the
 * server accepted, whose answer could not be read — never as a lost
 * connection, and the drift is logged.
 */

/** A fresh idempotency key for one person action. */
export const newResearchActionId = (): string => crypto.randomUUID()

/**
 * What every research action does with a failure before the control reads it:
 * - an answer that broke the contract was still an accepted action, so it is
 *   logged where it can be investigated;
 * - a not-ready refusal means the products list's readiness verdict is stale,
 *   so it is read again, and every doorway — the composer's button, a new
 *   brief's form — shows the readiness screen and its way forward instead of
 *   offering research the server will refuse.
 */
const useDeepWaterActionError = () => {
  const queryClient = useQueryClient()
  return (error: unknown): void => {
    if (!(error instanceof ApiClientError)) return
    if (error.code === 'INVALID_RESPONSE') {
      console.error('[deep-water] a research action was accepted but its answer did not match the contract', error.details)
    }
    if (error.code === DEEP_WATER_BRIEF_ERROR_CODES.NOT_READY) {
      void queryClient.invalidateQueries({ queryKey: integratedProductsKeyPrefix })
    }
  }
}

/**
 * Start's answer is the research view, a subset of the brief view: laid over
 * the brief the dialog holds, it shows the research starting — and Start no
 * longer offered — the moment the server has accepted it, not a refetch later.
 */
export const briefWithRunView = (brief: DeepWaterBriefView, run: DeepWaterResearchRunView): DeepWaterBriefView =>
  brief.id === run.id ? { ...brief, ...run } : brief

export const useCreateResearchBrief = () => {
  const api = useApiClient()
  const queryClient = useQueryClient()
  const onError = useDeepWaterActionError()
  const scope = useDeepWaterViewerScope()
  return useMutation({
    mutationFn: (input: CreateDeepWaterBriefRequest): Promise<DeepWaterBriefView> =>
      api.post(RESEARCH_RUNS_PATH, input, undefined, DeepWaterBriefViewSchema),
    onError,
    onSuccess: (brief) => {
      if (scope) queryClient.setQueryData(deepWaterKeys.brief(brief.id, scope), brief)
    },
    // An answer that could not be read may still have opened a brief: the lists show it either way.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: deepWaterKeys.lists })
    },
  })
}

/** A reply to DeepWater's planner, carrying any edits to the pillars and settings. */
export const useReplyToResearchBrief = (runId: string) => {
  const api = useApiClient()
  const queryClient = useQueryClient()
  const onError = useDeepWaterActionError()
  const scope = useDeepWaterViewerScope()
  return useMutation({
    mutationFn: (input: DeepWaterBriefReplyRequest): Promise<DeepWaterBriefView> =>
      api.post(`${researchRunPath(runId)}/messages`, input, undefined, DeepWaterBriefViewSchema),
    onError,
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
  const onError = useDeepWaterActionError()
  const scope = useDeepWaterViewerScope()
  return useMutation({
    mutationFn: (input: StartDeepWaterBriefRequest): Promise<DeepWaterResearchRunView> =>
      api.post(`${researchRunPath(runId)}/start`, input, undefined, DeepWaterResearchRunViewSchema),
    onError,
    onSuccess: (run) => {
      if (!scope) return
      queryClient.setQueryData<DeepWaterBriefView>(
        deepWaterKeys.brief(runId, scope),
        (brief) => (brief ? briefWithRunView(brief, run) : brief),
      )
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: deepWaterKeys.run(runId) })
      void queryClient.invalidateQueries({ queryKey: deepWaterKeys.lists })
    },
  })
}

/**
 * What a cancel is answered with: the research view for a viewer who may read
 * the run, or only its id and status for a team owner or admin who may not
 * (amendments N8.5). Both carry these two fields, and nothing else is read
 * from the answer — the refetch shows the rest.
 */
const ResearchCancelAnswerSchema = z.object({ id: z.string().uuid(), status: z.string().min(1) })
export type ResearchCancelAnswer = z.infer<typeof ResearchCancelAnswerSchema>

/**
 * Where a research stands after a cancel was accepted, read from that answer.
 * The API answers 202 once it has recorded the cancel for its worker, so a
 * research is usually still open then — DeepWater stops it a moment later —
 * and only a research cancelled on the spot (one DeepWater never received, or
 * had not named yet) or one that ended meanwhile is already over. The view's
 * statuses and a non-viewer's raw run statuses spell the finished ones alike.
 */
export const hasResearchStopped = (answer: Pick<ResearchCancelAnswer, 'status'>): boolean =>
  answer.status === 'cancelled' || answer.status === 'completed' || answer.status === 'failed'
    || answer.status === 'warning'

/**
 * Cancel a brief or a running research — the requester's own, or, for a team
 * owner or admin, any open research in the team (amendments N8.5).
 *
 * The mutation stays pending until the run has been read again: the brief
 * then shows the cancel in flight (`pendingAction.kind === 'cancel'`), so the
 * dialog goes from "sending" to "cancelling" without offering Cancel again in
 * between.
 */
export const useCancelResearchRun = () => {
  const api = useApiClient()
  const queryClient = useQueryClient()
  const onError = useDeepWaterActionError()
  return useMutation({
    mutationFn: (input: { actionId: string; runId: string }): Promise<ResearchCancelAnswer> =>
      api.post(`${researchRunPath(input.runId)}/cancel`, { actionId: input.actionId }, undefined,
        ResearchCancelAnswerSchema),
    onError,
    onSettled: async (_result, _error, input) => {
      void queryClient.invalidateQueries({ queryKey: deepWaterKeys.lists })
      await queryClient.invalidateQueries({ queryKey: deepWaterKeys.run(input.runId) })
    },
  })
}

/** Try delivering a finished research again after a retryable block ("Retry import"). */
export const useRetryResearchDelivery = () => {
  const api = useApiClient()
  const queryClient = useQueryClient()
  const onError = useDeepWaterActionError()
  return useMutation({
    mutationFn: (input: { actionId: string; runId: string }): Promise<DeepWaterResearchRunView> =>
      api.post(
        `${researchRunPath(input.runId)}/deliver`,
        { actionId: input.actionId },
        undefined,
        DeepWaterResearchRunViewSchema,
      ),
    onError,
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
