import type { AppCategory } from '@nessie/schemas'
import { TabBar } from '../../primitives/TabBar'
import { AppCategorySelect } from './AppCategorySelect'
import { AppSearchInput } from './AppSearchInput'
import type {
  AppCategorySectionModel,
  AppFilter,
  AppFilterOption,
} from './app-catalogue-view'

type AppsToolbarProps = {
  activeCategory: AppCategory | null
  filter: AppFilter
  filterOptions: AppFilterOption[]
  onFilterChange: (filter: AppFilter) => void
  onQueryChange: (query: string) => void
  onSelectCategory: (category: AppCategory | null) => void
  query: string
  sections: readonly AppCategorySectionModel[]
}

// The one bar that stays with you down the page: search, the All/Installed
// filter, and the category dropdown at the far right. It sticks to the top so
// a long shelf never leaves a person scrolling back up to change what they
// are looking at. One row at lg and up; on a narrow screen it wraps, with the
// dropdown going full-width rather than overflowing.
export const AppsToolbar = ({
  activeCategory,
  filter,
  filterOptions,
  onFilterChange,
  onQueryChange,
  onSelectCategory,
  query,
  sections,
}: AppsToolbarProps) => (
  <div
    className={[
      'sticky top-0 z-20 -mx-4 border-b border-[color:var(--line)]',
      'bg-[color:var(--main)] px-4 py-3 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8',
    ].join(' ')}
    data-testid="apps-toolbar"
  >
    <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
      <div className="flex items-center gap-3 lg:flex-1">
        <AppSearchInput onChange={onQueryChange} value={query} />
      </div>
      <div className="w-full lg:w-auto lg:min-w-[14rem]" data-testid="apps-filter">
        <TabBar
          ariaLabel="Filter apps"
          fullWidth
          items={filterOptions}
          onChange={onFilterChange}
          role="radiogroup"
          value={filter}
        />
      </div>
      <AppCategorySelect
        activeCategory={activeCategory}
        onSelect={onSelectCategory}
        sections={sections}
      />
    </div>
  </div>
)
