import { z } from 'zod'

/**
 * Whether people in this organisation may pair outside agents with their
 * accounts.
 *
 * Pairing hands a program a ninety-day credential that acts as the person who
 * approved it. That is a reasonable thing for a member to decide for their own
 * account — and an unreasonable thing for an organisation to have no view of
 * or say in, which is what "any member, no list, no switch" amounted to.
 *
 * It rides the one settings cascade (`docs/standards/scoped-settings.md`)
 * rather than a bespoke column, so the answer resolves organisation → team →
 * person and stops at the first level that locked it. Absent means allowed: an
 * installation that has never thought about this keeps working exactly as it
 * did.
 *
 * **Only the organisation level has a surface today**
 * (`/settings/organization/paired-agents`, which always writes the key locked).
 * The cascade will honour a team or personal row the moment one exists, but
 * nothing writes them, so do not describe those levels as available to a person
 * until something does — a capability nobody can reach is not a capability.
 */
export const AGENT_PAIRING_SETTING_KEY = 'agents.pairing'

export const AgentPairingSettingSchema = z.object({
  allowed: z.boolean(),
}).strict()
export type AgentPairingSetting = z.infer<typeof AgentPairingSettingSchema>

/**
 * Read the resolved value.
 *
 * Absent means allowed — an installation that has never thought about pairing
 * keeps working exactly as it did, and there is nothing to misread.
 *
 * A row that is *present* and does not parse is the opposite case and takes the
 * opposite answer. Somebody wrote that row to express a decision; reading
 * `{"allowed":"false"}` as permission would grant the very thing they sat down
 * to forbid. A security switch that fails open on malformed input is not a
 * switch, so a value that exists and cannot be understood denies.
 */
export const agentPairingAllowed = (value: unknown): boolean => {
  if (value === null || value === undefined) return true
  const parsed = AgentPairingSettingSchema.safeParse(value)
  return parsed.success ? parsed.data.allowed : false
}
