import { useId } from 'react'
import { SectionLabel } from '../primitives/SectionLabel'
import { TabBar } from '../primitives/TabBar'

/**
 * Pick exactly one option, inside a form.
 *
 * Five hand-rolled versions existed: three byte-identical button rows copied
 * across the integrations panels, a ring-selected button list in
 * `CreateSpaceDialog`, a solid-fill one in `VersionHistory`, radio cards in
 * the appearance panels, and a pair of primary/secondary buttons in
 * `ProjectSettingsPage`. Only the appearance panels used real radios, so the
 * rest were unreachable by keyboard as a group and announced as a row of
 * unrelated buttons.
 *
 * A compact inline choice delegates its visual and keyboard behaviour to
 * `TabBar` in `radiogroup` mode, so every segmented row in the app has one
 * sliding selection pill. Card choices remain real radios: their explanations
 * are the content of the choice, not a compact segment label.
 */

export type ChoiceOption<T extends string> = {
  /** A second line explaining the option; only the `card` variant renders it. */
  description?: string
  disabled?: boolean
  label: string
  value: T
}

export type ChoiceVariant = 'card' | 'inline'

type ChoiceGroupProps<T extends string> = {
  className?: string
  /** Names the group for assistive tech; also the visible legend unless hidden. */
  label: string
  /** Hides the legend visually while keeping it announced. */
  labelHidden?: boolean
  onChange: (value: T) => void
  options: ChoiceOption<T>[]
  value: T
  /**
   * `inline` — a row of compact chips, for a short list of one-word options.
   * `card` — stacked cards with descriptions, for a choice that needs
   * explaining.
   */
  variant?: ChoiceVariant
}

const cardClass = (selected: boolean): string =>
  [
    'block cursor-pointer rounded-md border p-3 text-left transition-colors',
    selected
      ? 'border-[color:var(--accent)] bg-[color:var(--accent-soft)]'
      : 'border-[color:var(--sep)] hover:bg-[color:var(--overlay-weak)]',
  ].join(' ')

export const ChoiceGroup = <T extends string>({
  className,
  label,
  labelHidden = false,
  onChange,
  options,
  value,
  variant = 'inline',
}: ChoiceGroupProps<T>) => {
  const name = useId()

  return (
    <fieldset className={['border-0 p-0', className ?? ''].filter(Boolean).join(' ')}>
      <legend className={labelHidden ? 'sr-only' : 'mb-1.5'}>
        {labelHidden ? label : <SectionLabel as="span" size="sm">{label}</SectionLabel>}
      </legend>

      {variant === 'inline' ? (
        <TabBar
          ariaLabel={label}
          items={options.map((option) => ({
            disabled: option.disabled,
            label: option.label,
            value: option.value,
          }))}
          onChange={onChange}
          role="radiogroup"
          value={value}
        />
      ) : (
        <div className="grid gap-2">
          {options.map((option) => {
            const selected = option.value === value

            return (
              <label className={cardClass(selected)} key={option.value}>
                {/*
                  * A real radio, visually hidden. It is what makes the group one
                  * arrow-key stop with one announced value, which every
                  * button-row version of this lost.
                  */}
                <input
                  checked={selected}
                  className="sr-only"
                  disabled={option.disabled}
                  name={name}
                  onChange={() => onChange(option.value)}
                  type="radio"
                  value={option.value}
                />
                <span className="block text-sm font-semibold text-[color:var(--tx)]">
                  {option.label}
                </span>
                {option.description ? (
                  <span className="mt-0.5 block text-xs text-[color:var(--tx3)]">
                    {option.description}
                  </span>
                ) : null}
              </label>
            )
          })}
        </div>
      )}
    </fieldset>
  )
}
