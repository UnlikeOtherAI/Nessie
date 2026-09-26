import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { LABEL_PALETTE, LabelColorSchema } from '@nessie/schemas'
import { useTranslation } from 'react-i18next'
import { Popover } from '../overlays/Popover'
import { Input } from './FormControls'

/** Semantic palette IDs, in `LABEL_PALETTE` order. */
const LABEL_PALETTE_IDS = [
  'grey', 'red', 'orange', 'amber', 'yellow', 'green',
  'teal', 'blue', 'indigo', 'violet', 'pink', 'brown',
] as const

const swatchStyle = (color: string) => ({ '--label': color }) as CSSProperties

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
  const { t } = useTranslation('common')
  const anchorRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value)
  const [invalid, setInvalid] = useState(false)
  const colorName = (color: string): string => {
    const index = LABEL_PALETTE.findIndex((entry) => entry === color.toLowerCase())
    const id = LABEL_PALETTE_IDS[index]
    return id ? t(`colourNames.${id}`) : color.toLowerCase()
  }
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
        aria-label={t('colourFor', { label, colour: colorName(value) })}
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
          {LABEL_PALETTE.map((color) => (
            <button
              aria-label={colorName(color)}
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
          aria-label={t('hexColour')}
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
            {t('invalidHexColour')}
          </p>
        ) : null}
      </Popover>
    </>
  )
}
