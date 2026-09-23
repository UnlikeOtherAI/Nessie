import { lockDeepWaterBriefRun, recordDeepWaterDeliveryMessage } from '@nessie/runtime'
import { DeepWaterDeliveryMessageMetadataSchema } from '@nessie/schemas'

import { runDeepWaterTransaction, type DeepWaterAnnounceDeps } from './deepwater-announce.js'
import { wakeIdentityChangedNotice } from './deepwater-copy.js'
import { deepWaterTopicPreview, postDeepWaterNotice } from './deepwater-messages.js'

/**
 * A woken agent's run that failed because it could not act for the person
 * who asked: their sign-in changed after the research was delivered to the
 * agent (Water plan amendments-fable F4, amendments N4). Delivery counted the
 * wake the moment it was claimed or pended, so nothing else would tell them
 * the research ended, or where its report is. They are told as they would be
 * for a wake that reached nobody: DeepWater's own notice, under the card, with
 * the Knowledge link for a finished research.
 *
 * Only a terminal wake (`completed`, `failed`) of a delivered run is owed
 * this. A planner-turn wake is not: the brief's own watch read blocks on the
 * same identity and tells the requester. Once per run, under its row lock:
 * the notice becomes the run's result message.
 */

export type DeepWaterWakeFailureOutcome =
  /** The requester was told now, or already had been. */
  | 'told'
  /** The failed run was not a terminal DeepWater wake of a delivered run. */
  | 'not_owed'

export const tellRequesterDeepWaterWakeFailed = async (
  deps: DeepWaterAnnounceDeps,
  input: { organizationId: string; kickoffMessageId: string },
): Promise<DeepWaterWakeFailureOutcome> => {
  const kickoff = await deps.prisma.message.findUnique({
    where: { id: input.kickoffMessageId },
    select: { metadata: true },
  })
  const parsed = DeepWaterDeliveryMessageMetadataSchema.safeParse(kickoff?.metadata)
  if (!parsed.success) return 'not_owed'
  const { runId, kind } = parsed.data.deepWaterDelivery
  if (kind !== 'completed' && kind !== 'failed') return 'not_owed'

  return runDeepWaterTransaction(deps, async (tx, announce) => {
    const locked = await lockDeepWaterBriefRun(tx, { organizationId: input.organizationId, runId })
    if (!locked) return 'not_owed'
    const { run } = locked
    if (run.deliveredAt === null || run.wakeMessageId !== input.kickoffMessageId) return 'not_owed'
    if (run.resultMessageId !== null) return 'told'

    const topic = deepWaterTopicPreview(run)
    let content: string
    if (kind === 'completed') {
      const page = run.knowledgePageId
        ? await tx.knowledgePage.findFirst({
            where: { id: run.knowledgePageId, organizationId: run.organizationId },
            select: { spaceId: true },
          })
        : null
      if (!page || !run.knowledgePageId) {
        // Delivery imports the page before it wakes anyone; without it there
        // is no link to give, and the agent's own failure reply stands.
        console.error(`[deep-water] run ${run.id}: a delivered research has no report page to point its requester at`)
        return 'not_owed'
      }
      content = wakeIdentityChangedNotice({
        topic,
        finished: true,
        link: `/knowledge-base?spaceId=${page.spaceId}&pageId=${run.knowledgePageId}`,
      })
    } else {
      content = wakeIdentityChangedNotice({ topic, finished: false, failureCode: run.failureCode })
    }
    const notice = await postDeepWaterNotice(tx, announce, run, {
      kind: kind === 'completed' ? 'wake_unreachable' : 'failed',
      content,
      alertKey: `deep-water-wake-identity:${run.id}`,
    })
    if (!notice) return 'not_owed'
    await recordDeepWaterDeliveryMessage(tx, {
      organizationId: run.organizationId,
      runId: run.id,
      resultMessageId: notice.messageId,
    })
    console.warn(`[deep-water] wake for run ${run.id} failed on the requester's sign-in; told them instead`)
    return 'told'
  })
}
