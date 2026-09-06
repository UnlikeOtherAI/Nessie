import { z } from 'zod'

/**
 * The look a person wants their agents' portraits drawn in — "cartoon",
 * "photorealistic", "flat vector", whatever words they used.
 *
 * It is a **setting**, not a memory: an avatar style stated once in a design
 * conversation has to survive that conversation, and semantic recall over past
 * messages is the wrong instrument for a value the next portrait must read
 * deterministically. It therefore goes through the one cascade
 * (`docs/standards/scoped-settings.md`): an organisation that wants a house
 * style sets it at the organisation level and can lock it, a person's own
 * choice sits at the person level, and the resolver already answers "who
 * decided this".
 *
 * Free text rather than an enum, for the same reason intent is never
 * string-matched here: a style is whatever the person said, in their language,
 * and it is passed to the avatar prompt writer as additional guidance — the
 * same channel the avatar dialog's own free-text box already uses, inside the
 * same fixed constraints. It is descriptive data about a picture, never an
 * instruction to the run that reads it.
 */
export const AGENT_AVATAR_STYLE_SETTING_KEY = 'agentAvatar.style'

/** Long enough for a sentence of taste, short enough to stay a style. */
export const AGENT_AVATAR_STYLE_MAX_LENGTH = 200

export const AgentAvatarStyleSchema = z
  .string()
  .trim()
  .min(1)
  .max(AGENT_AVATAR_STYLE_MAX_LENGTH)
export type AgentAvatarStyle = z.infer<typeof AgentAvatarStyleSchema>

/**
 * A stored value read back from `ScopedSetting`, where it is untyped JSON.
 * Anything that is not a usable style — a cleared row, a number a hand-written
 * write left behind — resolves to `null` rather than reaching an image prompt.
 */
export const parseStoredAgentAvatarStyle = (value: unknown): string | null => {
  const parsed = AgentAvatarStyleSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
