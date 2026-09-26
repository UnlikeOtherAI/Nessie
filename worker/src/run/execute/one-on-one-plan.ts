import { ChannelDecisionSnapshotSchema, ONE_ON_ONE_DECISION_FINGERPRINT } from '@nessie/schemas'

import { isContentlessAfterReacting } from './working-marker.js'

/**
 * What Jev decided for one reply in a one-on-one room
 * (docs/standards/reply-threads.md → "One-on-one rooms"), as the run carries it.
 */
export type OneOnOneReplyPlan = {
  /** Do what was asked and mark the message done instead of writing a reply. */
  acknowledgeWhenDone: boolean
  /** The earlier message the person's message goes back to, and how the answer points there. */
  earlier?: { messageId: string; reference: 'mention' | 'link' | 'thread' }
}

/** Marks a message the agent did what it asked, without a written reply. */
export const DONE_REACTION = '✅'

/**
 * The plan pinned on this run's trigger message, for this exact agent and
 * principal. Only a one-on-one snapshot carries one; a channel policy's
 * snapshot, no snapshot, or one that no longer parses is no plan, and the run
 * answers where its placement already says.
 */
export const readOneOnOnePlan = (
  channelDecision: unknown,
  target: { agentId: string; principalUserId?: string | null | undefined },
): OneOnOneReplyPlan | undefined => {
  if (channelDecision == null) return undefined
  const parsed = ChannelDecisionSnapshotSchema.safeParse(channelDecision)
  if (!parsed.success || parsed.data.policyFingerprint !== ONE_ON_ONE_DECISION_FINGERPRINT) {
    return undefined
  }
  for (const decision of parsed.data.decisions) {
    if (
      decision.action !== 'reply'
      || decision.agentId !== target.agentId
      || (decision.principalUserId ?? null) !== (target.principalUserId ?? null)
    ) continue
    return {
      acknowledgeWhenDone: decision.acknowledgeWhenDone === true,
      ...(decision.earlierMessageId && decision.earlierReference
        ? { earlier: { messageId: decision.earlierMessageId, reference: decision.earlierReference } }
        : {}),
    }
  }
  return undefined
}

/**
 * Work Jev judged needs no written reply, finished with nothing worth reading:
 * the platform marks the message done. The same structural test a reaction
 * answer passes (`isContentlessAfterReacting`) with the plan standing in for
 * the `react` call — and never when the agent already reacted itself, because
 * then its own reaction is the mark.
 */
export const isMarkedDone = (
  plan: OneOnOneReplyPlan | undefined,
  reacted: boolean,
  responseText: string,
): boolean =>
  plan?.acknowledgeWhenDone === true && !reacted && isContentlessAfterReacting(true, responseText)

/**
 * The earlier message whose reply thread the answer belongs in, when the plan
 * says so. Jev only ever offers top-level messages, so the message is its own
 * thread's root.
 */
export const earlierThreadRoot = (plan: OneOnOneReplyPlan | undefined): string | undefined =>
  plan?.earlier?.reference === 'thread' ? plan.earlier.messageId : undefined

const EXCERPT_LENGTH = 160

const excerptOf = (content: string): string => {
  const flat = content.replace(/\s+/g, ' ').trim()
  return flat.length <= EXCERPT_LENGTH ? flat : `${flat.slice(0, EXCERPT_LENGTH)}…`
}

/**
 * What the run is told about the plan. Where the reply lands is the platform's
 * job and already done; the model is told what the person's message goes back
 * to so it can answer about the right thing, and — for work — that no written
 * reply is owed.
 *
 * `earlierContent` is that message's text from the run's own admitted
 * transcript, so naming it reads nothing the run had not already read; it is
 * null when the message is older than the transcript or withheld from it.
 */
export const buildOneOnOnePlanBlock = (
  plan: OneOnOneReplyPlan | undefined,
  earlierContent: string | null,
): string | null => {
  if (!plan) return null
  const lines: string[] = []
  if (plan.acknowledgeWhenDone) {
    lines.push(
      'The person asked for something to be done, not for a written answer. Do it with your tools. '
      + 'When it is done, end your turn without text: their message is marked done for you. '
      + 'Write only if something failed, you need their decision, or the result holds something they must read.',
    )
  }
  if (plan.earlier) {
    const quoted = earlierContent?.trim() ? `: “${excerptOf(earlierContent)}”` : ''
    lines.push(`Their message goes back to an earlier message in this chat${quoted}.`)
    lines.push({
      mention: 'Your reply goes in the main chat; refer to that earlier message in words where it helps.',
      link: 'Your reply goes in the main chat with a link to that earlier message beside it, '
        + 'so point to it rather than repeating it.',
      thread: 'Your reply is posted under that earlier message, as a thread, '
        + 'so answer as part of that discussion.',
    }[plan.earlier.reference])
  }
  return lines.length > 0 ? lines.join('\n') : null
}
