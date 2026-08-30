import { faChevronDown } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { AppCategory } from '@nessie/schemas'
import {
  ALL_CATEGORIES_VALUE,
  appCategoryOptions,
  type AppCategorySectionModel,
} from './app-catalogue-view'

type AppCategorySelectProps = {
  activeCategory: AppCategory | null
  onSelect: (category: AppCategory | null) => void
  sections: readonly AppCategorySectionModel[]
}

/**
 * The category narrowing, on the far right of the search row. A native select:
 * accessible by default, and one control rather than a chip per category now
 * that the registry has made the taxonomy wide. Its first option is "All" —
 * choosing it clears the narrowing (`null`), which is the only way back.
 *
 * The wrapper carries the type scale for the same reason AppSearchInput's
 * does: the unlayered `select { font: inherit }` reset makes `text-sm` on the
 * control itself inert. `appearance-none` plus the painted chevron, because
 * the platform arrow ignores the theme's colours in the daylight theme.
 */
export const AppCategorySelect = ({
  activeCategory,
  onSelect,
  sections,
}: AppCategorySelectProps) => (
  <div className="relative w-full text-sm lg:w-auto" data-testid="apps-category-select-wrap">
    <FontAwesomeIcon
      aria-hidden
      className="pointer-events-none absolute right-3 top-1/2 h-3 w-3 -translate-y-1/2 text-[color:var(--tx3)]"
      icon={faChevronDown}
    />
    <select
      aria-label="Filter apps by category"
      className={[
        'h-9 w-full appearance-none rounded-[var(--radius-md)] border border-[color:var(--sep)]',
        'bg-[color:var(--panel)] pl-3 pr-9 text-[color:var(--tx)]',
        'focus:border-[color:var(--accent)] focus:outline-none focus:ring-2',
        'focus:ring-[color:var(--accent-soft)] lg:w-auto lg:min-w-[12rem]',
      ].join(' ')}
      data-testid="apps-category-select"
      onChange={(event) => {
        const value = event.target.value
        onSelect(value === ALL_CATEGORIES_VALUE ? null : (value as AppCategory))
      }}
      value={activeCategory ?? ALL_CATEGORIES_VALUE}
    >
      {appCategoryOptions(sections).map((option) => (
        <option key={option.value === ALL_CATEGORIES_VALUE ? 'all' : option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  </div>
)
