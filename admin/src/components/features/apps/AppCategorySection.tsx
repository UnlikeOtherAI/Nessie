import { AppCard } from './AppCard'
import {
  APP_GRID_CLASS,
  sectionOffersShowAll,
  sectionToggleLabel,
  sectionVisibleApps,
  type AppCategorySectionModel,
} from './app-catalogue-view'

type AppCategorySectionProps = {
  expanded: boolean
  onToggleExpanded: () => void
  pageSize: number
  section: AppCategorySectionModel
}

export const appCategorySectionId = (category: string): string => `apps-category-${category}`

// One category, two rows deep by default. "Show all" expands it in place rather
// than navigating: a person comparing three sections should never lose the
// other two to see the rest of one.
export const AppCategorySection = ({
  expanded,
  onToggleExpanded,
  pageSize,
  section,
}: AppCategorySectionProps) => {
  const visible = sectionVisibleApps(section, pageSize, expanded)

  return (
    <section
      // The sticky bar sits over the top of the page, and it is taller on
      // phone where the filter row stacks under the search field.
      className="mt-10 scroll-mt-32 lg:scroll-mt-20"
      data-testid={`app-category-section-${section.category}`}
      id={appCategorySectionId(section.category)}
    >
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <h2 className="flex items-baseline gap-2 text-base font-semibold text-[color:var(--tx)]">
          {section.label}
          <span className="text-sm font-normal text-[color:var(--tx3)]">
            ({section.apps.length})
          </span>
        </h2>
        {sectionOffersShowAll(section, pageSize) ? (
          <button
            className="text-[color:var(--accent)] hover:text-[color:var(--accent-hover)]"
            data-testid={`app-category-toggle-${section.category}`}
            onClick={onToggleExpanded}
            type="button"
          >
            <span className="text-xs font-medium">{sectionToggleLabel(section, expanded)}</span>
          </button>
        ) : null}
      </div>
      <div className={APP_GRID_CLASS}>
        {visible.map((app) => (
          <AppCard app={app} key={app.id} />
        ))}
      </div>
    </section>
  )
}
