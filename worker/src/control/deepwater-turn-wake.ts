import type { Prisma } from '@prisma/client'
import {
  claimDeepWaterTurnWake,
  recordDeepWaterAgentWake,
  type DeepWaterBriefRun,
} from '@nessie/runtime'

import type { DeepWaterAnnouncements } from './deepwater-announce.js'
import { turnKickoff, wakeCapNotice, wakeUnreachableNotice } from './deepwater-copy.js'
import { deepWaterTopicPreview, postDeepWaterNotice } from './deepwater-messages.js'
import { wakeDeepWaterAgent } from './deepwater-wake.js'

/**
 * A settled planner turn an agent is waiting on wakes that agent, once
 * (Water plan amendments N4, C1). The claim, the wake and its count commit
 * together under the run's row lock; past the cap the person is told once
 * instead, and a wake that cannot reach anyone becomes a notice to them.
 * Acks never wake: only the watch, after the projection advanced.
 */
export const handleDeepWaterTurnWake = async (
  tx: Prisma.TransactionClient,
  announce: DeepWaterAnnouncements,
  run: DeepWaterBriefRun,
): Promise<void> => {
  const claimed = await claimDeepWaterTurnWake(tx, { organizationId: run.organizationId, runId: run.id })
  if (!claimed) return
  const { decision } = claimed
  const topic = deepWaterTopicPreview(claimed.run)
  if (decision.kind === 'cap_notice') {
    await postDeepWaterNotice(tx, announce, claimed.run, { kind: 'wake_cap', content: wakeCapNotice(topic) })
    return
  }
  if (decision.kind !== 'wake' || !claimed.run.externalRunId) return

  const wake = await wakeDeepWaterAgent(tx, claimed.run, {
    agentId: decision.agentId,
    kind: 'turn',
    turnId: decision.turn.id,
    content: turnKickoff({ topic, researchId: claimed.run.externalRunId, turn: decision.turn }),
  })
  if (wake.kind === 'claimed' || wake.kind === 'pended') {
    await recordDeepWaterAgentWake(tx, { organizationId: run.organizationId, runId: run.id })
    return
  }
  if (wake.kind === 'unreachable') {
    console.warn(`[deep-water] wake unreachable (${wake.reason}) for run ${run.id}, turn ${decision.turn.seq}`)
    await postDeepWaterNotice(tx, announce, claimed.run, {
      kind: 'wake_unreachable',
      content: wakeUnreachableNotice({ topic, finished: false, link: null }),
      alertKey: `deep-water-wake-unreachable:${run.id}:${decision.turn.seq}`,
    })
  }
}
