import { AGENT_SPEAKING_STYLE_PRESETS } from '@nessie/schemas'

/**
 * The dropdown is a starting point; the field is the answer.
 *
 * The stored value is always the *text*, so the select cannot hold a preset id
 * of its own — a remembered id would let a later render replace wording the
 * person had edited. Its value is therefore derived from the text on every
 * render, and reads "custom" the moment the text stops matching a preset
 * exactly. Extracted from the component for the same reason `run-limits.ts` is:
 * the rule is testable, the markup is not.
 */

/** The select's value when the text is not one of the presets verbatim. */
export const CUSTOM_STYLE_VALUE = 'custom'

export const presetForText = (text: string): string => {
  const trimmed = text.trim()
  if (trimmed.length === 0) return CUSTOM_STYLE_VALUE
  return (
    AGENT_SPEAKING_STYLE_PRESETS.find((preset) => preset.text === trimmed)?.id
    ?? CUSTOM_STYLE_VALUE
  )
}

/**
 * The wording a preset seeds, or null for anything else — including
 * `CUSTOM_STYLE_VALUE`, which describes text that already exists and must
 * never overwrite it.
 */
export const presetTextById = (id: string): string | null =>
  AGENT_SPEAKING_STYLE_PRESETS.find((preset) => preset.id === id)?.text ?? null
