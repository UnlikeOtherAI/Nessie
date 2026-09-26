import type { ComponentProps } from 'react'
import { useTranslation } from 'react-i18next'
import type { KnowledgeRoot, KnowledgeRootSpace } from '@nessie/schemas'
import { ColumnBrowserColumn } from '../../../shared/column-browser/ColumnBrowserColumn'
import { FinderAgentsColumn } from './FinderAgentsColumn'

type FinderAgentsBrowserColumnProps = {
  activeAgentId?: string
  backToRoot?: () => void
  columnActive: boolean
  onOpen: (space: KnowledgeRootSpace) => void
  query: { isError: boolean; isLoading: boolean; refetch: () => unknown }
  resize: ComponentProps<typeof ColumnBrowserColumn>['resize']
  root?: KnowledgeRoot
}

/** The pushed Agents directory, including its framework-owned Back doorway. */
export const FinderAgentsBrowserColumn = ({
  activeAgentId,
  backToRoot,
  columnActive,
  onOpen,
  query,
  resize,
  root,
}: FinderAgentsBrowserColumnProps) => {
  const { t } = useTranslation('knowledgeFinder')
  return (
  <ColumnBrowserColumn
    key="virtual:agents"
    onBack={backToRoot}
    resize={resize}
    screen
    scrollKey="finder:agents"
    showBack={Boolean(backToRoot)}
    title={t('agents')}
  >
    <FinderAgentsColumn
      activeAgentId={activeAgentId}
      columnActive={columnActive}
      onOpen={onOpen}
      query={query}
      root={root}
    />
  </ColumnBrowserColumn>
  )
}
