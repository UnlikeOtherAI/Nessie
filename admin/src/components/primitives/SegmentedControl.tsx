type SegmentedControlOption<T extends string> = {
  count?: number
  label: string
  value: T
}

type SegmentedControlProps<T extends string> = {
  ariaLabel: string
  onChange: (value: T) => void
  options: Array<SegmentedControlOption<T>>
  value: T
}

/**
 * Single-select segmented control for filter dimensions that must be
 * glanceable (one calm strip instead of a field of pills). Counts render
 * inline so the distribution is visible without clicking through.
 */
export const SegmentedControl = <T extends string>({
  ariaLabel,
  onChange,
  options,
  value,
}: SegmentedControlProps<T>) => (
  <div
    aria-label={ariaLabel}
    className="flex w-full gap-0.5 rounded-lg bg-[var(--overlay-weak)] p-0.5"
    role="radiogroup"
  >
    {options.map((option) => {
      const selected = option.value === value
      return (
        <button
          aria-checked={selected}
          className={[
            'flex-1 rounded-md px-2 py-1 text-xs transition-colors',
            selected
              ? 'bg-[color:var(--panel)] font-medium text-[color:var(--tx)] shadow-sm'
              : 'text-[color:var(--tx3)] hover:text-[color:var(--tx)]',
          ].join(' ')}
          key={option.value}
          onClick={() => onChange(option.value)}
          role="radio"
          type="button"
        >
          {option.label}
          {option.count !== undefined ? (
            <span className={selected ? 'ml-1 text-[color:var(--tx3)]' : 'ml-1 opacity-70'}>
              {option.count}
            </span>
          ) : null}
        </button>
      )
    })}
  </div>
)
