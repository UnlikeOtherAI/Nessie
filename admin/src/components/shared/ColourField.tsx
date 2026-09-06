import { useEffect, useState } from 'react'
import { normaliseHex } from '@nessie/schemas'
import { Input } from './FormControls'

/**
 * One colour, entered two ways
 * (docs/plans/2026-09-05-organisation-custom-theme.md §7.3).
 *
 * The OS picker for choosing, a hex box for pasting the value a brand guide
 * gives you — both bound to the same string. `onChange` only ever fires with a
 * normalised lowercase `#rrggbb`, so the one spelling that reaches the API is
 * the one spelling stored, and string equality is colour equality.
 *
 * It carries no colour of its own beyond the value it is showing: like every
 * other control here, its own chrome is theme tokens.
 */
export const ColourField = ({
  disabled = false,
  label,
  onChange,
  value,
}: {
  disabled?: boolean
  /**
   * What this colour is, for assistive tech. Three of these sit on the
   * organisation Appearance page, so a shared "Colour picker" would name all
   * three the same and leave a screen-reader user unable to tell them apart.
   */
  label: string
  onChange: (hex: string) => void
  value: string
}) => {
  // The text box holds what is being typed, which is not yet a colour. It
  // re-seeds whenever the committed value changes underneath it — the picker
  // moving, or "Derive from the accent" filling the sidebar in.
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])

  const commit = (next: string): void => {
    const normalised = normaliseHex(next)
    if (normalised) onChange(normalised)
    else setDraft(value)
  }

  return (
    <div className="flex items-center gap-2">
      <input
        aria-label={`${label} colour picker`}
        className="admin-input admin-input-colour"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value.toLowerCase())}
        type="color"
        value={value}
      />
      <Input
        aria-label={`${label} hex value`}
        className="max-w-[9rem]"
        disabled={disabled}
        mono
        onBlur={(event) => commit(event.target.value)}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit(draft)
          }
        }}
        size="compact"
        spellCheck={false}
        value={draft}
      />
    </div>
  )
}
