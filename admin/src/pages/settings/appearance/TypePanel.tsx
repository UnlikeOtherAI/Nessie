import { useFontScale, type FontScale } from '../../../providers/FontScaleProvider'
import { SectionLabel } from '../../../components/primitives/SectionLabel'

const PREVIEW_SIZE: Record<FontScale, string> = {
  small: '14px',
  medium: '16px',
  large: '18px',
}

export const TypePanel = () => {
  const { fontScale, scales, setFontScale } = useFontScale()

  return (
    <section className="admin-card p-4">
      <SectionLabel>Text size</SectionLabel>
      <div className="mt-2 text-sm text-[color:var(--tx2)]">
        Sets the text size across every page. Saved to your account.
      </div>

      <fieldset className="mt-4 grid gap-3 border-0 p-0 md:grid-cols-3">
        <legend className="sr-only">Text size</legend>
        {scales.map((option) => {
          const selected = fontScale === option.id

          return (
            <label
              key={option.id}
              className={[
                'admin-card cursor-pointer p-3 transition',
                'focus-within:outline focus-within:outline-2 focus-within:outline-offset-2',
                'focus-within:outline-[color:var(--accent)]',
                selected
                  ? 'bg-[color:var(--accent-soft)] ring-2 ring-[color:var(--accent)]'
                  : 'hover:bg-[color:var(--main-hover)]',
              ].join(' ')}
            >
              <input
                checked={selected}
                className="sr-only"
                name="fontScale"
                onChange={() => setFontScale(option.id)}
                type="radio"
                value={option.id}
              />
              <div className="flex items-center justify-between gap-3">
                <div className="font-semibold text-[color:var(--tx)]">{option.label}</div>
                <span
                  aria-hidden="true"
                  className="leading-none text-[color:var(--tx2)]"
                  style={{ fontSize: PREVIEW_SIZE[option.id] }}
                >
                  Aa
                </span>
              </div>
              <div className="mt-1 text-sm text-[color:var(--tx2)]">{option.description}</div>
            </label>
          )
        })}
      </fieldset>
    </section>
  )
}
