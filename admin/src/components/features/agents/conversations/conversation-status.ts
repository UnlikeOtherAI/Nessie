import type { AgentConversationRecord } from '@nessie/schemas'
import type { PillTone } from '../../../primitives/Pill'

/**
 * What a conversation's status chip says, decided from the record alone.
 *
 * Structural, and pure, for one reason: a card must never show a status the
 * record did not state, and must never compose one from what was said in the
 * conversation. The whole mapping is here so the card, the list and their
 * tests read the same table — and so a new run status is one line here rather
 * than a chain of ternaries in JSX.
 *
 * Spec: docs/plans/2026-09-08-agent-conversations.md § "The conversation card".
 */

/** A leading dot before the label: `--success` while running, `--tx3` queued. */
export type ConversationStatusDot = 'muted' | 'success' | null

export type ConversationStatus = {
  label: string
  tone: PillTone
  dot: ConversationStatusDot
}

type StatusInput = Pick<AgentConversationRecord, 'activeRun' | 'lastRunOutcome'>

export const conversationStatus = ({
  activeRun,
  lastRunOutcome,
}: StatusInput): ConversationStatus => {
  if (activeRun) {
    switch (activeRun.status) {
      case 'running':
        return { dot: 'success', label: 'Running', tone: 'success' }
      case 'pending':
        return { dot: 'muted', label: 'Queued', tone: 'muted' }
      case 'waiting_approval':
        return { dot: null, label: 'Waiting for approval', tone: 'warning' }
      case 'waiting_input':
        return { dot: null, label: 'Needs a reply', tone: 'warning' }
    }
  }
  switch (lastRunOutcome) {
    case 'completed':
      return { dot: null, label: 'Done', tone: 'muted' }
    case 'failed':
      return { dot: null, label: 'Failed', tone: 'danger' }
    case 'cancelled':
      return { dot: null, label: 'Cancelled', tone: 'muted' }
    // A conversation nobody has run yet — the ordinary state of one that was
    // opened empty from the rail.
    case null:
      return { dot: null, label: 'Not started', tone: 'muted' }
  }
}

/**
 * The one muted line under the title: what it is doing right now while a run
 * is in flight, else the newest thing said, else that nothing has been.
 *
 * `progressLine` wins over the preview deliberately — while a run is live the
 * question is "what is happening", and the newest message is the request that
 * started it.
 */
export const conversationBodyLine = (
  {
    activeRun,
    lastMessagePreview,
  }: Pick<AgentConversationRecord, 'activeRun' | 'lastMessagePreview'>,
  // A list row and a card say the empty case differently — "No messages yet"
  // in a list of rooms, "Nothing said yet" on a card about one conversation —
  // so the caller supplies the words and the precedence stays here.
  empty = 'Nothing said yet',
): string => activeRun?.progressLine || lastMessagePreview || empty

/**
 * How often a list of conversations asks again.
 *
 * Fast only while something on it is actually running — that is when a person
 * is watching a dot or a progress line change. An idle list left open in a
 * column would otherwise poll at the watching beat for as long as the panel
 * stood there, and an infinite list refetches every retained page each time.
 */
export const conversationListCadence = (input: {
  conversations: readonly { activeRun: unknown }[]
  railPollMs: number
  watchingPollMs: number
}): number =>
  input.conversations.some((conversation) => conversation.activeRun !== null)
    ? input.watchingPollMs
    : input.railPollMs
