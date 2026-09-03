import {
  AGENT_SPEAKING_STYLE_MAX_CHARS,
  AGENT_SPEAKING_STYLE_PRESETS,
  GEMINI_LIVE_VOICES,
} from '@nessie/schemas'
import { CUSTOM_STYLE_VALUE, presetForText, presetTextById } from './speaking-style'
import { FormField } from '../../../shared/FormField'
import { Select, Textarea } from '../../../shared/FormControls'

/**
 * How this agent sounds, and how it talks.
 *
 * Two settings that answer the same question from a person's point of view —
 * "what is it like to talk to this agent" — so they sit together rather than
 * one beside Model and the other beside System prompt.
 *
 * The style dropdown is a *starting point*, never the stored value: picking a
 * preset writes its wording into the field below, and after that the field is
 * the person's. Nothing rewrites it unless a different preset is picked, which
 * is why the select's own value is derived from the text rather than held in
 * state — a remembered id would let a re-render silently replace an edit.
 *
 * Voices are `GEMINI_LIVE_VOICES` and nothing else: Google publishes no API
 * that enumerates them, so the list is curated once in `@nessie/schemas` and
 * read here.
 */

const DEFAULT_VOICE_VALUE = ''

type AgentSpeechFieldsetProps = {
  /**
   * Read-only rendering, for an agent the viewer may not edit (a global agent
   * ships with the deployment). Carried on the `<fieldset>` rather than each
   * control: the native attribute disables every descendant, including one
   * added here later, which is exactly the drift a per-control prop invites —
   * this section shipped after the read-only mode and stayed live on a
   * blueprint agent's page until a browser pass caught it.
   */
  disabled?: boolean
  onSpeakingStyleChange: (style: string) => void
  onVoiceNameChange: (voiceName: string) => void
  speakingStyle: string
  voiceName: string
}

export const AgentSpeechFieldset = ({
  disabled = false,
  onSpeakingStyleChange,
  onVoiceNameChange,
  speakingStyle,
  voiceName,
}: AgentSpeechFieldsetProps) => {
  const selectedPreset = presetForText(speakingStyle)

  return (
    <fieldset
      className="grid gap-3 border-0 p-0"
      data-testid="agent-speech"
      disabled={disabled}
    >
      {/* A `<legend>` cannot be a `<label htmlFor>`, so it carries FieldLabel's
          classes directly — the same exception `RunLimitsFieldset` documents. */}
      <legend className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]">
        Voice and manner
      </legend>
      {/* A legend sits outside the grid flow, so without a line of prose under
          it the heading collides with the first field's own label. */}
      <p className="text-xs text-[color:var(--tx3)]">
        The voice a call is spoken in, and how this agent talks to people
        everywhere.
      </p>

      <FormField
        help="Used when someone calls this agent. Falls back to the deployment default."
        label="Voice"
      >
        <Select
          onChange={(event) => onVoiceNameChange(event.target.value)}
          value={voiceName}
        >
          <option value={DEFAULT_VOICE_VALUE}>Deployment default</option>
          {GEMINI_LIVE_VOICES.map((voice) => (
            <option key={voice.name} value={voice.name}>
              {`${voice.name} — ${voice.description}`}
            </option>
          ))}
        </Select>
      </FormField>

      <FormField
        help="Pick a starting point, then edit the wording below however you like."
        label="How the agent talks to you"
      >
        <Select
          onChange={(event) => {
            // "Custom" describes text that already exists — selecting it must
            // not wipe the wording it is describing, so it seeds nothing.
            const text = presetTextById(event.target.value)
            if (text !== null) onSpeakingStyleChange(text)
          }}
          value={selectedPreset}
        >
          <option value={CUSTOM_STYLE_VALUE}>
            {speakingStyle.trim() ? 'Custom (edited below)' : 'None — no style set'}
          </option>
          {AGENT_SPEAKING_STYLE_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </Select>
      </FormField>

      <Textarea
        aria-label="Speaking style"
        autoComplete="off"
        className="resize-none"
        maxLength={AGENT_SPEAKING_STYLE_MAX_CHARS}
        onChange={(event) => onSpeakingStyleChange(event.target.value)}
        placeholder="e.g. Keep it short and skip the pleasantries."
        rows={4}
        size="compact"
        value={speakingStyle}
      />
    </fieldset>
  )
}
