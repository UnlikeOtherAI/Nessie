import type { GlobalSearchMode } from '../../../facades/search/hooks'

type SearchModeToggleProps = {
  mode: GlobalSearchMode
  onChange: (mode: GlobalSearchMode) => void
  compact?: boolean
}

const options = [
  { label: 'Text', value: 'text' },
  { label: 'Semantic', value: 'semantic' },
] as const

export const SearchModeToggle = ({
  compact = false,
  mode,
  onChange,
}: SearchModeToggleProps) => (
  <div
    aria-label="Search mode"
    className={[
      'inline-flex shrink-0 rounded-md border border-[color:var(--sep)]',
      'bg-[color:var(--overlay-weak)] p-0.5',
    ].join(' ')}
    role="group"
  >
    {options.map((option) => (
      <button
        aria-pressed={mode === option.value}
        className={[
          'rounded-[6px] font-medium transition-colors',
          compact ? 'h-6 px-2 text-[11px]' : 'h-8 px-3 text-xs',
          mode === option.value
            ? 'bg-[color:var(--main)] text-[color:var(--tx)] shadow-sm'
            : 'text-[color:var(--tx3)] hover:text-[color:var(--tx)]',
        ].join(' ')}
        key={option.value}
        onClick={() => onChange(option.value)}
        title={
          option.value === 'semantic'
            ? 'Semantic searches memory and knowledge by meaning. Messages stay in Text mode.'
            : 'Text searches channels, people, projects, messages, and knowledge.'
        }
        type="button"
      >
        {option.label}
      </button>
    ))}
  </div>
)
