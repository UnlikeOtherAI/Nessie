import type { GlobalSearchMode } from '../../../facades/search/hooks'
import { TabBar, type TabBarItem } from '../../primitives/TabBar'

type SearchModeToggleProps = {
  mode: GlobalSearchMode
  onChange: (mode: GlobalSearchMode) => void
  compact?: boolean
}

const options: ReadonlyArray<TabBarItem<GlobalSearchMode>> = [
  {
    label: 'Full text',
    title: 'Full text finds the words you entered across every searchable section.',
    value: 'fulltext',
  },
  {
    label: 'Semantic',
    title:
      'Semantic keeps exact matches and adds meaning-based message, ticket, document, and memory matches.',
    value: 'semantic',
  },
]

export const SearchModeToggle = ({
  compact = false,
  mode,
  onChange,
}: SearchModeToggleProps) => (
  <TabBar
    ariaLabel="Search mode"
    items={options}
    onChange={onChange}
    role="radiogroup"
    size={compact ? 'sm' : 'md'}
    value={mode}
  />
)
