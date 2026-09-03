import { z } from 'zod'

/**
 * How an agent talks to you — one per-agent instruction, two surfaces.
 *
 * The stored value is *text*, never a preset id. The Agent Designer's dropdown
 * writes a preset's wording into an editable field and then gets out of the
 * way: a person who tunes one sentence of "warm and conversational" would
 * otherwise have their edit thrown away by whatever the id resolved to on the
 * next read, and an id could never say "call me Ondra and skip the pleasantries".
 * The presets are a starting point, so they live beside the schema rather than
 * in the form — the same reason `GEMINI_LIVE_VOICES` does.
 *
 * It reaches the model through {@link buildSpeakingStyleBlock} on both surfaces
 * — the typed agent's system prompt (`buildModelPrompt`) and the voice call's
 * system instruction (`buildVoiceSystemInstruction`) — so the two cannot
 * disagree about what a person asked for.
 */

/**
 * Bounded like a paragraph, not like a prompt.
 *
 * A speaking style rides in *every* turn of a live call, where Gemini re-bills
 * the accumulated context each time anyone speaks; the field is for how to
 * talk, and standing instructions have their own, much larger home in the
 * system prompt.
 */
export const AGENT_SPEAKING_STYLE_MAX_CHARS = 600

export const AgentSpeakingStyleSchema = z.string().max(AGENT_SPEAKING_STYLE_MAX_CHARS)

export const AGENT_SPEAKING_STYLE_PRESETS = [
  {
    id: 'warm',
    label: 'Warm and conversational',
    text:
      'Talk like a friendly colleague: plain language, contractions, the odd '
      + 'aside. Warm without being gushing, and never formal for the sake of it.',
  },
  {
    id: 'direct',
    label: 'Brief and direct',
    text:
      'Answer first, in as few words as the question deserves. No preamble, no '
      + 'restating the question, no closing offers of further help.',
  },
  {
    id: 'formal',
    label: 'Formal and precise',
    text:
      'Write in full, measured sentences and precise wording. No slang, no '
      + 'contractions, no jokes. Say plainly when something is uncertain.',
  },
  {
    id: 'playful',
    label: 'Playful',
    text:
      'Keep it light — a bit of wit and personality is welcome. Never let a '
      + 'joke get in the way of the answer, and drop it entirely when the '
      + 'subject is serious.',
  },
  {
    id: 'patient',
    label: 'Patient and explanatory',
    text:
      'Assume the person is new to this. Explain the reasoning as well as the '
      + 'answer, define terms the first time they appear, and offer the next '
      + 'step.',
  },
] as const satisfies ReadonlyArray<{ id: string; label: string; text: string }>

export type AgentSpeakingStylePreset = (typeof AGENT_SPEAKING_STYLE_PRESETS)[number]

/**
 * The prompt block for a stored style, or null when there is none.
 *
 * Same trust tier as the agent's own system prompt — it is written by someone
 * entitled to edit the agent, not read out of a message — so it is stated as an
 * instruction rather than framed as untrusted material.
 */
export const buildSpeakingStyleBlock = (style: string | null | undefined): string | null => {
  const trimmed = style?.trim()
  if (!trimmed) return null
  return `How to talk to this person:\n${trimmed}`
}
