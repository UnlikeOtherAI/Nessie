import { createHash } from 'node:crypto'
import { stableStringify } from '@nessie/db'
import {
  StandingPolicyPinnedTermsSchema,
  TicketChangedWorkConfigSchema,
  type StandingPolicyLimits,
  type StandingPolicyPinnedTerms,
} from '@nessie/schemas'

/**
 * What a standing policy pins about its trigger, and how an edit is judged
 * against it (docs/plans/2026-09-23-ticket-driven-agents/machine-access.md →
 * "What is pinned"; docs/standards/ticket-work.md).
 *
 * The terms are the trigger's agent, target channel, board, start-work
 * columns and `assignOnPickup`, follow kinds and `includeSourceEvents`, end
 * columns, every instructions section verbatim, and every limit — the
 * trigger's `wakesPerTicket` and `startsPerDay` and the policy's own
 * `ticketHours`, `ticketUsd` and `dailyUsd`. `triggerDigest` is the digest of
 * exactly that object, so the binder recomputes it from the live trigger, and
 * the policy keeps the object beside it so a fresh card can say what changed.
 */

type TriggerRow = { agentId: string | null; config: unknown; targetChannelId: string | null }

const sorted = <T extends string>(values: readonly T[]): T[] => [...values].sort()

/**
 * The terms a trigger stands at now, with the policy's limits. Null when it
 * has nothing a policy could pin: no agent or channel, or a config that no
 * longer parses.
 */
export const standingPolicyTermsOf = (
  trigger: TriggerRow,
  policyLimits: StandingPolicyLimits,
): StandingPolicyPinnedTerms | null => {
  const parsed = TicketChangedWorkConfigSchema.safeParse(trigger.config)
  if (!parsed.success || !trigger.agentId || !trigger.targetChannelId) return null
  const config = parsed.data
  return StandingPolicyPinnedTermsSchema.parse({
    agentId: trigger.agentId,
    targetChannelId: trigger.targetChannelId,
    boardId: config.boardId,
    pickupColumnIds: sorted(config.pickup?.columnIds ?? []),
    assignOnPickup: config.pickup?.assignOnPickup ?? false,
    followKinds: sorted(config.follow.kinds),
    includeSourceEvents: config.follow.includeSourceEvents,
    endOn: [...config.endOn].sort((left, right) => stableStringify(left).localeCompare(stableStringify(right))),
    instructions: Object.fromEntries(Object.entries(config.instructions ?? {})
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    limits: {
      wakesPerTicket: config.limits.wakesPerTicket,
      startsPerDay: config.limits.startsPerDay,
      ticketHours: policyLimits.ticketHours,
      ticketUsd: policyLimits.ticketUsd,
      dailyUsd: policyLimits.dailyUsd,
    },
  })
}

/** The policy's own limits, out of its pinned terms. */
export const standingPolicyLimitsOf = (terms: StandingPolicyPinnedTerms): StandingPolicyLimits => ({
  dailyUsd: terms.limits.dailyUsd,
  ticketHours: terms.limits.ticketHours,
  ticketUsd: terms.limits.ticketUsd,
})

export const standingPolicyTermsDigest = (terms: StandingPolicyPinnedTerms): string =>
  `sha256:${createHash('sha256').update(stableStringify(terms)).digest('hex')}`

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
