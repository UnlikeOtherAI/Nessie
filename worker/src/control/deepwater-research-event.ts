import { applyDeepWaterProgress, claimDeepWaterEventRead } from '@nessie/runtime'
import { deepWaterProgressFromEvent, type DeepWaterResearchEventJobPayload } from '@nessie/schemas'

import { runDeepWaterTransaction } from './deepwater-announce.js'
import { runDeepWaterWatch, type DeepWaterWatchDeps } from './deepwater-watch.js'

/**
 * One research event DeepWater pushed (Water plan amendments-streaming S2),
 * verified and resolved to its run by the API's receiver.
 *
 * - `research.progress` is stored as sent (`scope_json.progress`) when
 *   DeepWater observed it later than the snapshot already stored, and the run
 *   is announced (`integration.run.updated`) so its card moves. It is the one
 *   fact no Ledger read carries. It never wakes an agent, posts a message or
 *   raises an alert, whatever it says.
 * - A settled planner turn or an outcome is a trigger, never an authority: it
 *   claims a watch read of the run now, and the read is the watch's own
 *   (`runDeepWaterWatch`) — so the attach (N1), both registers (N2), delivery
 *   (N3) and the wakes (N4) happen exactly as they would when the watch reads
 *   the run on its own, from what Ledger answers, never from the event body.
 *   An agent is therefore woken only for a settled turn it authored and for
 *   its research's outcome, and a person gets the result reply with its
 *   mention and push alert, each once, however often DeepWater sends the
 *   event.
 */

const log = (payload: DeepWaterResearchEventJobPayload, what: string): void => {
  console.info(
    `[deep-water] event ${payload.event.event_id} (${payload.event.type}) for run ${payload.runId}: ${what}`,
  )
}

const storeProgress = async (
  deps: DeepWaterWatchDeps,
  payload: DeepWaterResearchEventJobPayload,
  progress: NonNullable<DeepWaterResearchEventJobPayload['event']['progress']>,
): Promise<void> => {
  const outcome = await runDeepWaterTransaction(deps, async (tx, announce) => {
    const applied = await applyDeepWaterProgress(tx, {
      organizationId: payload.organizationId,
      runId: payload.runId,
      researchId: payload.event.research.ledger_research_id,
      progress: deepWaterProgressFromEvent(progress),
    })
    if (applied.applied) announce.run(applied.run)
    return applied
  })
  // An older snapshot arriving late is the ordinary case, not news.
  if (!outcome.applied && outcome.reason !== 'stale') log(payload, `progress not stored (${outcome.reason})`)
}

export const handleDeepWaterResearchEvent = async (
  deps: DeepWaterWatchDeps,
  payload: DeepWaterResearchEventJobPayload,
): Promise<void> => {
  const { event } = payload
  if (event.type === 'research.progress') {
    // The contract carries `progress` exactly on this type.
    if (!event.progress) throw new Error(`research.progress event ${event.event_id} carries no progress`)
    await storeProgress(deps, payload, event.progress)
    return
  }
  const claim = await deps.prisma.$transaction((tx) => claimDeepWaterEventRead(tx, {
    organizationId: payload.organizationId,
    runId: payload.runId,
  }))
  if (!claim) {
    log(payload, 'the watch does not read this run (blocked, ended or a launcher run); nothing to do')
    return
  }
  await runDeepWaterWatch(deps, claim)
}
