import { useId } from 'react'

/**
 * A themed checkbox, for choosing several things from a set.
 *
 * The admin's rule, which nothing stated before: **`Switch` turns one thing on
 * or off; `Checkbox` picks several out of many.** `AgentDesignerForm` used both
 * for the same kind of boolean nineteen lines apart, four settings used a raw
 * checkbox where a `Switch` sat one file over, and `ProjectSettingsPage`
 * expressed a binary choice as a pair of buttons.
 *
 * `accent-[var(--accent)]` is not optional: the raw checkboxes that skipped it
 * (`ExecutorCreatePanel`, `ExecutorDesktopCompanionPanel`) render their checked
 * state in the browser's own blue, which belongs to no theme.
 */

type CheckboxProps = {
  checked: boolean
  disabled?: boolean
  /** Secondary line under the label, for what the option means. */
  description?: string
  label: string
  onChange: (checked: boolean) => void
}

export const Checkbox = ({
  checked,
  description,
  disabled = false,
  label,
  onChange,
}: CheckboxProps) => {
  const id = useId()

  return (
    <div className="flex items-start gap-2">
      <input
        aria-describedby={description ? `${id}-description` : undefined}
        checked={checked}
        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
        disabled={disabled}
        id={id}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      <div className="min-w-0">
        <label
          className={[
            'text-sm text-[color:var(--tx)]',
            disabled ? 'opacity-50' : 'cursor-pointer',
          ].join(' ')}
          htmlFor={id}
        >
          {label}
        </label>
        {description ? (
          <div className="text-xs text-[color:var(--tx3)]" id={`${id}-description`}>
            {description}
          </div>
        ) : null}
      </div>
    </div>
  )
}
