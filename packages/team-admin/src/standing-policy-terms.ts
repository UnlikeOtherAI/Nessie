import { stableStringify } from '@nessie/db'
import type { StandingPolicyPinnedTerms } from '@nessie/schemas'

/**
 * How a trigger edit is judged against what a standing policy pinned, and
 * what a fresh card says changed
 * (docs/plans/2026-09-23-ticket-driven-agents/machine-access.md → "What is
 * pinned"). The terms themselves and their digest are
 * `@nessie/executor-manage`'s (`executor-standing-policy-terms.ts`), which
 * the binder shares.
 */

const INSTRUCTION_LABELS: Record<string, string> = {
  general: 'the general instructions',
  onPickup: 'the instructions for a pickup',
  onQueued: 'the instructions for a queued ticket',
  onReminder: 'the instructions for a reminder',
  onSessionTurnEnded: 'the instructions for a coding turn ending',
  onTicketChanged: 'the instructions for a ticket change',
}

const LIMIT_LABELS: Record<keyof StandingPolicyPinnedTerms['limits'], string> = {
  dailyUsd: 'the daily spend',
  startsPerDay: 'the tickets a day',
  ticketHours: 'the hours a ticket',
  ticketUsd: 'the spend a ticket',
  wakesPerTicket: 'the wakes a ticket',
}

const FIELD_LABELS: Record<Exclude<keyof StandingPolicyPinnedTerms, 'instructions' | 'limits'>, string> = {
  agentId: 'the agent',
  assignOnPickup: 'assigning the ticket on pickup',
  boardId: 'the board',
  endOn: 'the columns that end work',
  followKinds: 'what wakes the agent',
  includeSourceEvents: 'connected-board events',
  pickupColumnIds: 'the start-work columns',
  targetChannelId: 'the channel',
}

const same = (left: unknown, right: unknown): boolean => stableStringify(left) === stableStringify(right)

/** Which pinned terms differ, in plain words, in a stable order. */
export const changedStandingPolicyTerms = (
  pinned: StandingPolicyPinnedTerms,
  current: StandingPolicyPinnedTerms,
): string[] => [
  ...(Object.keys(FIELD_LABELS) as (keyof typeof FIELD_LABELS)[])
    .filter((key) => !same(pinned[key], current[key]))
    .map((key) => FIELD_LABELS[key]),
  ...[...new Set([...Object.keys(pinned.instructions), ...Object.keys(current.instructions)])].sort()
    .filter((key) => pinned.instructions[key] !== current.instructions[key])
    .map((key) => INSTRUCTION_LABELS[key] ?? `the ${key} instructions`),
  ...(Object.keys(LIMIT_LABELS) as (keyof typeof LIMIT_LABELS)[])
    .filter((key) => pinned.limits[key] !== current.limits[key])
    .map((key) => LIMIT_LABELS[key]),
]

/**
 * How a trigger edit stands against what a policy pinned: unchanged; only
 * limits lowered (or kept), which is the one edit that keeps the policy live
 * with its terms moved down; or changed, which suspends it.
 */
export const judgeStandingPolicyTermsChange = (
  pinned: StandingPolicyPinnedTerms,
  current: StandingPolicyPinnedTerms,
): { kind: 'same' } | { kind: 'lowered' } | { kind: 'changed'; fields: string[] } => {
  if (same(pinned, current)) return { kind: 'same' }
  const { limits: pinnedLimits, ...pinnedRest } = pinned
  const { limits: currentLimits, ...currentRest } = current
  const lowered = same(pinnedRest, currentRest)
    && (Object.keys(pinnedLimits) as (keyof typeof pinnedLimits)[])
      .every((key) => currentLimits[key] <= pinnedLimits[key])
  return lowered ? { kind: 'lowered' } : { kind: 'changed', fields: changedStandingPolicyTerms(pinned, current) }
}
