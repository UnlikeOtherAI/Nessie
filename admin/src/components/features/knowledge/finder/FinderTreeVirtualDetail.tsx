import { FinderVirtualHost, type FinderVirtualRow } from './FinderVirtualColumn'
import type { FinderSelection, FinderSelectionEvent } from './finder-selection'

type FinderTreeVirtualDetailProps = {
  dispatch: (event: FinderSelectionEvent) => void
  kind: 'latest' | 'shared-with-me'
  openDocument: (page: { id: string; spaceId: string; title: string }, inPlace: () => void) => void
  openPageDeepLink: (input: { pageId: string; spaceId: string }) => void
  query: {
    fetchNextPage: () => unknown
    hasNextPage?: boolean
    isError: boolean
    isFetchingNextPage: boolean
    isLoading: boolean
    refetch: () => unknown
  }
  rows: FinderVirtualRow[]
  selection: FinderSelection
}

export const FinderTreeVirtualDetail = ({
  dispatch,
  kind,
  openDocument,
  openPageDeepLink,
  query,
  rows,
  selection,
}: FinderTreeVirtualDetailProps) => (
  <div className="h-full overflow-y-auto px-3 py-2">
    <h2 className="mb-2 px-1 text-lg font-semibold">
      {kind === 'latest' ? 'Latest' : 'Shared with me'}
    </h2>
    <FinderVirtualHost
      columnKey={`virtual:${kind}`}
      dispatch={dispatch}
      kind={kind}
      onOpen={(row) => {
        const inPlace = () => openPageDeepLink({ pageId: row.id, spaceId: row.home.spaceId })
        if (row.kind === 'folder') return inPlace()
        openDocument({ id: row.id, spaceId: row.home.spaceId, title: row.title }, inPlace)
      }}
      query={query}
      rows={rows}
      selection={selection}
    />
  </div>
)
