import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { LABEL_PALETTE, LabelColorSchema } from '@nessie/schemas'
import { Popover } from '../overlays/Popover'
import { Input } from './FormControls'

/** The palette's names, in `LABEL_PALETTE` order, for the swatches' accessible names. */
export const LABEL_PALETTE_NAMES = [
  'Grey', 'Red', 'Orange', 'Amber', 'Yellow', 'Green',
  'Teal', 'Blue', 'Indigo', 'Violet', 'Pink', 'Brown',
] as const

const swatchStyle = (color: string) => ({ '--label': color }) as CSSProperties

export const labelColorName = (color: string): string => {
  const index = LABEL_PALETTE.findIndex((entry) => entry === color.toLowerCase())
  return index === -1 ? color.toLowerCase() : (LABEL_PALETTE_NAMES[index] ?? color)
}

type LabelColorPickerProps = {
  disabled?: boolean
  /** Whose colour this is — "Colour of Bug" — for assistive tech. */
  label: string
  /** Fires with a validated lower-case `#rrggbb` only. */
  onChange: (color: string) => void
  value: string
}

/**
 * A label's colour: a swatch button opening the twelve palette swatches and a
 * hex box for anything else. The hex is checked by `LabelColorSchema`, the
 * same rule the API applies, so nothing the route would refuse is ever sent.
 * Colours are data painted through `--label`; no class carries one.
 */
export const LabelColorPicker = ({ disabled = false, label, onChange, value }: LabelColorPickerProps) => {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value)
  const [invalid, setInvalid] = useState(false)
  useEffect(() => {
    setDraft(value)
    setInvalid(false)
  }, [value, open])

  const choose = (color: string) => {
    onChange(color)
    setOpen(false)
  }

  const commitDraft = () => {
    const candidate = draft.trim().toLowerCase()
    const withHash = candidate.startsWith('#') ? candidate : `#${candidate}`
    const parsed = LabelColorSchema.safeParse(withHash)
    if (!parsed.success) {
      setInvalid(true)
      return
    }
    choose(parsed.data)
  }

  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${label}: ${labelColorName(value)}`}
        className="admin-label-swatch-button"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        ref={anchorRef}
        style={swatchStyle(value)}
        type="button"
      >
        <span aria-hidden="true" className="admin-label-swatch" />
      </button>
      <Popover
        anchorRef={anchorRef}
        className="admin-label-color-popover"
        label={label}
        onClose={() => setOpen(false)}
        open={open}
        placement="bottom-start"
        role="dialog"
      >
        <div className="admin-label-color-grid">
          {LABEL_PALETTE.map((color, index) => (
            <button
              aria-label={LABEL_PALETTE_NAMES[index]}
              aria-pressed={color === value.toLowerCase()}
              className="admin-label-swatch-button"
              key={color}
              onClick={() => choose(color)}
              style={swatchStyle(color)}
              type="button"
            >
              <span aria-hidden="true" className="admin-label-swatch" />
            </button>
          ))}
        </div>
        <Input
          aria-invalid={invalid || undefined}
          aria-label="Hex colour"
          className="mt-2"
          mono
          onChange={(event) => {
            setDraft(event.target.value)
            setInvalid(false)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commitDraft()
            }
          }}
          placeholder="#rrggbb"
          size="compact"
          value={draft}
        />
        {invalid ? (
          <p className="mt-1 text-xs text-[color:var(--danger-text)]" role="alert">
            Use # and six hex digits.
          </p>
        ) : null}
      </Popover>
    </>
  )
}
