import type { DragEvent, ReactNode } from 'react'
import { ColumnBrowserColumn } from '../../../shared/column-browser/ColumnBrowserColumn'
import { FinderVirtualHost, type FinderVirtualRow } from './FinderVirtualColumn'
import type { FinderSelection, FinderSelectionEvent } from './finder-selection'

/**
 * Latest and Shared with me as a column.
 *
 * They are one shape with two corpora, and neither is a place a file can live
 * — a row in Latest is standing somewhere else — so the column swallows a file
 * drop and refuses it rather than letting the browser navigate the tab to the
 * dropped file (uploads-and-indexing.md §1).
 */
export const FinderVirtualPane = ({
  columnKey,
  dispatch,
  kind,
  onBack,
  onOpen,
  query,
  refuseProps,
  resize,
  rows,
  selection,
}: {
  columnKey: string
  dispatch: (event: FinderSelectionEvent) => void
  kind: 'latest' | 'shared-with-me'
  onBack?: () => void
  onOpen: (row: FinderVirtualRow) => void
  query: Parameters<typeof FinderVirtualHost>[0]['query']
  refuseProps: {
    onDragOver: (event: DragEvent<HTMLElement>) => void
    onDrop: (event: DragEvent<HTMLElement>) => void
  }
  resize: Parameters<typeof ColumnBrowserColumn>[0]['resize']
  rows: FinderVirtualRow[]
  selection: FinderSelection
}): ReactNode => (
  <ColumnBrowserColumn
    onBack={onBack}
    resize={resize}
    showBack
    scrollKey={`finder:${columnKey}`}
    title={kind === 'latest' ? 'Latest' : 'Shared with me'}
  >
    <div className="h-full" {...refuseProps}>
      <FinderVirtualHost
        columnKey={columnKey}
        dispatch={dispatch}
        kind={kind}
        onOpen={onOpen}
        query={query}
        rows={rows}
        selection={selection}
      />
    </div>
  </ColumnBrowserColumn>
)
