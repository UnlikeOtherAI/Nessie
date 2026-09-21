/**
 * Accept the model's acknowledgement emoji only if it actually is one.
 *
 * This value is model-authored and lands verbatim in a `MessageReaction` row
 * that is broadcast to the whole channel — a surface nothing renders as prose
 * and nobody reads as content, which is exactly what makes it a good place to
 * hide a sentence. `String(parsed.emoji)` accepted any length of anything.
 *
 * Structural, not semantic: this constrains the *shape* of a value (is it a
 * short pictographic token?), never the meaning of a message. Every character
 * must be pictographic, an emoji component, a ZWJ, or a variation selector, and
 * at least one must be pictographic — so ZWJ families and skin-tone modifiers
 * pass while "12" or a paragraph does not.
 */
const EMOJI_SHAPE =
  /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\u200D|\uFE0F|\uFE0E)+$/u
const MAX_EMOJI_UTF16_UNITS = 32

export const parseAcknowledgeEmoji = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (value.length === 0 || value.length > MAX_EMOJI_UTF16_UNITS) return null
  if (!/\p{Extended_Pictographic}/u.test(value)) return null
  return EMOJI_SHAPE.test(value) ? value : null
}
