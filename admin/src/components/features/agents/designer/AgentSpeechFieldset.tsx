import {
  AGENT_SPEAKING_STYLE_MAX_CHARS,
  AGENT_SPEAKING_STYLE_PRESETS,
  GEMINI_LIVE_VOICES,
} from '@nessie/schemas'
import { CUSTOM_STYLE_VALUE, presetForText, presetTextById } from './speaking-style'
import { FormField } from '../../../shared/FormField'
import { Select, Textarea } from '../../../shared/FormControls'

/**
 * How this agent sounds on a call, and how it talks everywhere.
 *
 * The two used to share one fieldset. They answer different questions on the
 * agent page, so they now live on different tabs: the voice beside the other
 * run settings (Settings), the manner beside the instructions it is published
 * with as `personality.md` (Instructions).
 *
 * Each renders inside its own `<fieldset>`, and read-only is that element's
 * `disabled` rather than a per-control prop: the native attribute disables
 * every descendant, including one added here later — the drift a per-control
 * prop invites, and exactly how this section once stayed live on a built-in
 * agent's page after the read-only mode shipped.
 *
 * Voices are `GEMINI_LIVE_VOICES` and nothing else: Google publishes no API
 * that enumerates them, so the list is curated once in `@nessie/schemas`.
 */

const DEFAULT_VOICE_VALUE = ''

const legendClass = 'text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]'

type AgentVoiceFieldProps = {
  disabled?: boolean
  onVoiceNameChange: (voiceName: string) => void
  voiceName: string
}

export const AgentVoiceField = ({ disabled = false, onVoiceNameChange, voiceName }: AgentVoiceFieldProps) => (
  <fieldset className="grid gap-1.5 border-0 p-0" data-testid="agent-voice" disabled={disabled}>
    <FormField
      help="Used when someone calls this agent. Falls back to the default voice."
      label="Voice"
    >
      <Select onChange={(event) => onVoiceNameChange(event.target.value)} value={voiceName}>
        <option value={DEFAULT_VOICE_VALUE}>Default voice</option>
        {GEMINI_LIVE_VOICES.map((voice) => (
          <option key={voice.name} value={voice.name}>
            {`${voice.name} — ${voice.description}`}
          </option>
        ))}
      </Select>
    </FormField>
  </fieldset>
)

type AgentMannerFieldProps = {
  disabled?: boolean
  onSpeakingStyleChange: (style: string) => void
  speakingStyle: string
}

/**
 * The style dropdown is a *starting point*, never the stored value: picking a
 * preset writes its wording into the field below, and after that the field is
 * the person's. The select's value is derived from the text rather than held
 * in state, so a re-render can never silently replace an edit.
 */
export const AgentMannerField = ({
  disabled = false,
  onSpeakingStyleChange,
  speakingStyle,
}: AgentMannerFieldProps) => {
  const selectedPreset = presetForText(speakingStyle)
  return (
    <fieldset className="grid gap-3 border-0 p-0" data-testid="agent-manner" disabled={disabled}>
      {/* A `<legend>` cannot be a `<label htmlFor>`, so it carries FieldLabel's
          classes directly — the same exception `RunLimitsFieldset` documents. */}
      <legend className={legendClass}>Manner</legend>
      <p className="text-xs text-[color:var(--tx3)]">
        How this agent talks to people, everywhere. Saved as its personality.md.
      </p>
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
