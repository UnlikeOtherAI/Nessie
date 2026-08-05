import type { PrismaClient, RunReplyPlacement } from '@prisma/client'
import type { DeepWaterHandoffRunLocator } from '@nessie/runtime'

/**
 * Resolve where a run's agent-authored messages land. First match wins:
 *
 * 1. A DeepWater handoff run stays top-level, unconditionally — its message
 *    flow is byte-identical to before reply threads existed.
 * 2. A trigger message that is itself a reply attaches to the same root
 *    (one level deep): conversation continuity is a structural fact and
 *    outranks any placement judgement.
 * 3. A `channel` placement judgement posts top-level — the reply is a
 *    standalone contribution to the room, not an answer owed to the trigger.
 * 4. Otherwise the reply threads under the trigger message (#233 default,
 *    which is also what a null/absent judgement means).
 */
export const resolveReplyRootMessageId = (
  triggerMessage: { id: string; rootMessageId: string | null },
  handoffLocator: DeepWaterHandoffRunLocator | null,
  replyPlacement: RunReplyPlacement | null,
): string | undefined => {
  if (handoffLocator) return undefined
  if (triggerMessage.rootMessageId) return triggerMessage.rootMessageId
  if (replyPlacement === 'channel') return undefined
  return triggerMessage.id
}

/**
 * Persist the resolved anchor onto the run row so REST readers (the thinking
 * bootstrap endpoint) can place a live bubble without re-deriving placement.
 * Best-effort: an anchor write must never fail a run that is otherwise fine —
 * the in-memory `context.replyRootMessageId` still drives message creation.
 */
export const persistResolvedReplyAnchor = async (
  prisma: PrismaClient,
  runId: string,
  replyRootMessageId: string | undefined,
): Promise<void> => {
  try {
    await prisma.run.update({
      where: { id: runId },
      data: { replyRootMessageId: replyRootMessageId ?? null },
    })
  } catch (error) {
    console.warn('[worker] failed to persist reply anchor for run', runId, error)
  }
}
