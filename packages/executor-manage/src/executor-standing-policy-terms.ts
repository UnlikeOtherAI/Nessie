import { createHash } from 'node:crypto'
import { stableStringify } from '@nessie/db'
import {
  StandingPolicyPinnedTermsSchema,
  TicketChangedWorkConfigSchema,
  TicketQuietWakeMinutesSchema,
  type StandingPolicyAgentPin,
  type StandingPolicyLimits,
  type StandingPolicyPinnedTerms,
} from '@nessie/schemas'

/**
 * What a standing policy pins about its trigger
 * (docs/plans/2026-09-23-ticket-driven-agents/machine-access.md → "What is
 * pinned"; docs/standards/ticket-work-machine-access.md).
 *
 * The terms are the trigger's agent and the agent's own definition
 * (`executor-standing-policy-agent.ts`), target channel, board, start-work
 * columns and `assignOnPickup`, follow kinds and `includeSourceEvents`, end
 * columns, every instructions section verbatim, the quiet wake, and every limit — the
 * trigger's `wakesPerTicket` and `startsPerDay` and the policy's own
 * `ticketHours`, `ticketUsd` and `dailyUsd`. `triggerDigest` is the digest of
 * exactly that object. The card that confirms it (team-admin) and the binder
 * that re-checks it at every wake (`executor-standing-policy-binding.ts`)
 * compute it here, so the two can never digest a trigger differently.
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
  agent: StandingPolicyAgentPin | null,
): StandingPolicyPinnedTerms | null => {
  const parsed = TicketChangedWorkConfigSchema.safeParse(trigger.config)
  if (!parsed.success || !trigger.agentId || !trigger.targetChannelId || !agent) return null
  const config = parsed.data
  const record = trigger.config && typeof trigger.config === 'object' ? trigger.config as Record<string, unknown> : {}
  const quiet = TicketQuietWakeMinutesSchema.safeParse(record['quietWakeMinutes'])
  return StandingPolicyPinnedTermsSchema.parse({
    agentId: trigger.agentId,
    agent,
    targetChannelId: trigger.targetChannelId,
    boardId: config.boardId,
    pickupColumnIds: sorted(config.pickup?.columnIds ?? []),
    assignOnPickup: config.pickup?.assignOnPickup ?? false,
    followKinds: sorted(config.follow.kinds),
    includeSourceEvents: config.follow.includeSourceEvents,
    endOn: [...config.endOn].sort((left, right) => stableStringify(left).localeCompare(stableStringify(right))),
    instructions: Object.fromEntries(Object.entries(config.instructions ?? {})
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    quietWakeMinutes: quiet.success ? quiet.data : TicketQuietWakeMinutesSchema.parse(undefined),
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
