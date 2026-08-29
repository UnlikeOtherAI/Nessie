import type { GlobalSearchMode } from '../../../facades/search/hooks'
import { TabBar, type TabBarItem } from '../../primitives/TabBar'

type SearchModeToggleProps = {
  mode: GlobalSearchMode
  onChange: (mode: GlobalSearchMode) => void
  compact?: boolean
}

const options: ReadonlyArray<TabBarItem<GlobalSearchMode>> = [
  {
    label: 'Text',
    title: 'Text searches channels, people, projects, messages, and knowledge.',
    value: 'text',
  },
  {
    label: 'Semantic',
    title:
      'Semantic searches memory and knowledge by meaning. Messages stay in Text mode.',
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
