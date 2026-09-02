import type { AgentTriggerActivityRecord, AgentTriggerRecord } from '../../../lib/api-client'

/**
 * How a list of triggers is grouped, and in what order.
 *
 * Time-based triggers lead because they are the ones that run without anybody
 * present: a schedule that has quietly stopped is the failure this product has
 * actually had, so it is what a person should see first. Everything else is
 * ordered by how much of its behaviour a reader has to go elsewhere to
 * understand — an event or a webhook fires on something outside this page, and
 * a manual trigger only fires when somebody presses it.
 *
 * `scheduled` and `interval` are one group, not two: "every 20 minutes" and
 * "at 09:00 on weekdays" answer the same question, and splitting them puts two
 * one-row sections where one belongs.
 */
export type TriggerGroupKey = 'time' | 'event' | 'webhook' | 'manual'

export type TriggerGroup = {
  description: string
  key: TriggerGroupKey
  title: string
  triggers: AgentTriggerRecord[]
}

const GROUP_ORDER: ReadonlyArray<{
  description: string
  key: TriggerGroupKey
  title: string
  types: ReadonlyArray<AgentTriggerRecord['type']>
}> = [
  {
    description: 'Runs on a clock, with nobody present.',
    key: 'time',
    title: 'Schedules',
    types: ['scheduled', 'interval'],
  },
  {
    description: 'Runs when something happens in the workspace.',
    key: 'event',
    title: 'Events',
    types: ['event'],
  },
  {
    description: 'Runs when an outside system calls in.',
    key: 'webhook',
    title: 'Webhooks',
    types: ['webhook'],
  },
  {
    description: 'Runs only when somebody starts it.',
    key: 'manual',
    title: 'Manual',
    types: ['manual'],
  },
]

/**
 * Groups in fixed order, empty ones dropped. A group carrying no triggers is a
 * heading that names no decision, so it is not rendered at all.
 */
export const groupTriggers = (triggers: AgentTriggerRecord[]): TriggerGroup[] =>
  GROUP_ORDER.map((group) => ({
    description: group.description,
    key: group.key,
    title: group.title,
    triggers: triggers.filter((trigger) => group.types.includes(trigger.type)),
  })).filter((group) => group.triggers.length > 0)

/**
 * The live state of one trigger, addressed by id. An absent entry is not an
 * error — activity is read separately from the records, so the first paint of
 * a list legitimately has none yet, and "unknown" must render as quiet rather
 * than as finished.
 */
export const findTriggerActivity = (
  activity: AgentTriggerActivityRecord[],
  triggerId: string,
): AgentTriggerActivityRecord | undefined =>
  activity.find((entry) => entry.triggerId === triggerId)
