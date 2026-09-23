import { useCallback } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { IntegrationRunUpdatedEventSchema } from '@nessie/schemas'
import type { SseFrame } from '../../lib/sse'
import { useEventStream } from '../realtime/event-stream'
import { DEEP_WATER_PRODUCT_SLUG } from './hooks'
import { deepWaterKeys } from './keys'

/**
 * `integration.run.updated` — a DeepWater research changed: its planner
 * answered, it started or finished, its result was delivered or blocked
 * (nessie.md §7.7). The event is content-free on purpose: a product slug and
 * a run id. The refetch it causes is the viewer-scoped read, so an id reaching
 * someone who may not see the run discloses nothing they can read.
 *
 * Handled once, in the shell, on the shared event stream. There is no polling
 * anywhere in the DeepWater surfaces: the stream resumes with Last-Event-ID
 * and a gap frame refetches everything (`realtime-gap.ts`).
 */

export const INTEGRATION_RUN_UPDATED_EVENT = 'integration.run.updated'

const eventData = (frameData: string): unknown => {
  const parsed = JSON.parse(frameData) as unknown
  // The stream carries the WS envelope ({type, event, data, ts}); the payload
  // is its `data`.
  if (parsed && typeof parsed === 'object' && 'data' in parsed) {
    return (parsed as { data: unknown }).data
  }
  return parsed
}

/**
 * Pure so the decision is testable without a stream: which run changed, or
 * null for any other frame, another product's run, or a frame that does not
 * parse (logged — a malformed frame must never break the stream).
 */
export const researchRunIdFromFrame = (frame: SseFrame): string | null => {
  if (frame.event !== INTEGRATION_RUN_UPDATED_EVENT || !frame.data) return null
  let data: unknown
  try {
    data = eventData(frame.data)
  } catch (error) {
    console.error('[deep-water] ignored an unreadable integration.run.updated frame', error)
    return null
  }
  const parsed = IntegrationRunUpdatedEventSchema.safeParse(data)
  if (!parsed.success) {
    console.error('[deep-water] ignored a malformed integration.run.updated frame', parsed.error.flatten())
    return null
  }
  return parsed.data.productSlug === DEEP_WATER_PRODUCT_SLUG ? parsed.data.runId : null
}

/** Everything a viewer reads about that run, plus every list it can appear in. */
export const invalidateResearchRun = (queryClient: QueryClient, runId: string): void => {
  void queryClient.invalidateQueries({ queryKey: deepWaterKeys.run(runId) })
  void queryClient.invalidateQueries({ queryKey: deepWaterKeys.lists })
}

/** Mount once, in `AdminShellLayout`. */
export const useDeepWaterRunEvents = (): void => {
  const queryClient = useQueryClient()
  const onFrame = useCallback((frame: SseFrame) => {
    const runId = researchRunIdFromFrame(frame)
    if (runId) invalidateResearchRun(queryClient, runId)
  }, [queryClient])
  useEventStream({ enabled: true, onFrame })
}
