import {
  DeepWaterHandoffFatalError,
  type DeepWaterHandoffGuard,
} from './deepwater-handoff-guard.js'

/**
 * An ordinary execution failure must not terminalize the Nessie run while its
 * attached DeepWater launch is still unattempted, ambiguous, or awaiting exact
 * result delivery. Promote that unresolved state to the handoff's fatal retry
 * path; preserve the original failure after a settled handoff.
 */
export const promoteUnresolvedDeepWaterHandoffError = (
  error: unknown,
  guard: DeepWaterHandoffGuard | null,
): unknown => {
  if (!guard || error instanceof DeepWaterHandoffFatalError) return error
  try {
    guard.assertCompletion()
    return error
  } catch (guardError) {
    return guardError instanceof DeepWaterHandoffFatalError ? guardError : error
  }
}
