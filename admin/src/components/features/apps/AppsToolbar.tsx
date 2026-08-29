import type { AppCategory } from '@nessie/schemas'
import { TabBar } from '../../primitives/TabBar'
import { AppCategoryNav } from './AppCategoryNav'
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
  onSelectCategory: (category: AppCategory) => void
  query: string
  sections: readonly AppCategorySectionModel[]
}

// The one bar that stays with you down the page: search, the filter, and the
// category jump list. It sticks to the top so a long shelf never leaves a
// person scrolling back up to change what they are looking at.
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
      <div className="flex items-center gap-3">
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
    </div>
    {/* One nav, not one per breakpoint: it changes shape (chips below lg, a
        slim inline list at lg and up) through its own classes. A second copy
        behind `hidden` would duplicate every test hook on the page. */}
    <div className="mt-2 lg:mt-3">
      <AppCategoryNav
        activeCategory={activeCategory}
        onSelect={onSelectCategory}
        sections={sections}
      />
    </div>
  </div>
)
