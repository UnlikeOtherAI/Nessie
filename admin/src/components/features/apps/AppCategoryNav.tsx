import type { AppCategory } from '@nessie/schemas'
import { appCategorySectionId } from './AppCategorySection'
import type { AppCategorySectionModel } from './app-catalogue-view'

type AppCategoryNavProps = {
  activeCategory: AppCategory | null
  onSelect: (category: AppCategory) => void
  sections: readonly AppCategorySectionModel[]
}

/**
 * Jump to a category without leaving the page.
 *
 * One component for both shapes: a slim inline row inside the sticky bar from
 * `lg` up, chunky chips below it. Two implementations of one list is the defect
 * this avoids — only the class strings differ.
 *
 * "Active" is the section the person last jumped to, not a scroll observer:
 * the nav answers "where did I go", and a highlight that drifts as the page
 * settles answers a question nobody asked.
 */
export const AppCategoryNav = ({ activeCategory, onSelect, sections }: AppCategoryNavProps) => {
  if (sections.length < 2) return null

  const jump = (category: AppCategory) => {
    onSelect(category)
    document
      .getElementById(appCategorySectionId(category))
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <nav
      aria-label="Jump to category"
      className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-2 lg:mx-0 lg:gap-3 lg:px-0 lg:pb-0"
      data-testid="apps-category-nav"
    >
      {sections.map((section) => {
        const active = section.category === activeCategory
        return (
          <button
            className={[
              'shrink-0 rounded-full border px-3 py-1.5',
              'transition-colors duration-[var(--duration-fast)]',
              'lg:border-transparent lg:bg-transparent lg:px-0 lg:py-0',
              active
                ? [
                  'border-[color:var(--accent)] bg-[color:var(--accent-soft)]',
                  'text-[color:var(--accent)] lg:text-[color:var(--tx)]',
                ].join(' ')
                : [
                  'border-[color:var(--sep)] bg-[color:var(--panel)] text-[color:var(--tx2)]',
                  'hover:text-[color:var(--tx)] lg:text-[color:var(--tx3)]',
                ].join(' '),
            ].join(' ')}
            data-testid={`apps-category-nav-${section.category}`}
            key={section.category}
            onClick={() => jump(section.category)}
            type="button"
          >
            {/* The unlayered control reset claims font size on buttons, so the
                type scale has to sit on an element inside one. */}
            <span className={active ? 'text-xs font-medium' : 'text-xs'}>{section.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
