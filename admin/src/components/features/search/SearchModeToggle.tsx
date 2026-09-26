import type { GlobalSearchMode } from '../../../facades/search/hooks'
import { TabBar, type TabBarItem } from '../../primitives/TabBar'
import { useTranslation } from 'react-i18next'

type SearchModeToggleProps = {
  mode: GlobalSearchMode
  onChange: (mode: GlobalSearchMode) => void
  compact?: boolean
}

export const SearchModeToggle = ({
  compact = false,
  mode,
  onChange,
}: SearchModeToggleProps) => {
  const { t } = useTranslation('search')
  const options: ReadonlyArray<TabBarItem<GlobalSearchMode>> = [
    { label: t('fulltext'), title: t('fulltextTitle'), value: 'fulltext' },
    { label: t('semantic'), title: t('semanticTitle'), value: 'semantic' },
  ]
  return (
    <TabBar
      ariaLabel={t('modeLabel')}
      items={options}
      onChange={onChange}
      role="radiogroup"
      size={compact ? 'sm' : 'md'}
      value={mode}
    />
  )
}
