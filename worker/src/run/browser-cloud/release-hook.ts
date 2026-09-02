/**
 * The seam that lets `updateRunStatus` release a run's cloud browser without
 * every terminal path having to remember to.
 *
 * A module-level hook rather than another parameter, because the point of
 * fusing this to the transition is that *no caller* participates: completion,
 * failure, budget stop, cancellation and a queue-redelivered crash all pass
 * through the one chokepoint, and adding an argument would put the obligation
 * back on the eight call sites. The worker registers it once at startup; any
 * process that does not (tests, the API) simply has no browsers to release.
 */

export type CloudBrowserReleaseHook = (runId: string) => Promise<void>

let hook: CloudBrowserReleaseHook | null = null

export const setCloudBrowserReleaseHook = (next: CloudBrowserReleaseHook | null): void => {
  hook = next
}

/**
 * Best-effort by construction: the run row is already terminal by the time
 * this runs, so a provider outage must never turn a finished run into a thrown
 * error. Anything left open is picked up by the expiry reaper.
 */
export const releaseRunCloudBrowsers = async (runId: string): Promise<void> => {
  if (!hook) return
  try {
    await hook(runId)
  } catch (error) {
    console.warn('[worker] could not release cloud browser for run', runId, error)
  }
}
