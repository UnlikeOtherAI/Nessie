import type { ReactNode } from 'react'
import { EmptyState } from '../../../shared/EmptyState'

type FinderTreeDetailProps = {
  documentPane?: ReactNode
  virtualContent?: ReactNode
}

/** Content beside the hierarchy; changing it must never switch the active view. */
export const FinderTreeDetail = ({
  documentPane,
  virtualContent,
}: FinderTreeDetailProps) => {
  if (documentPane) return documentPane
  if (virtualContent) return virtualContent
  return (
    <div className="flex h-full items-start justify-center p-6">
      <EmptyState className="max-w-lg">
        Select a document from the tree to read it here.
      </EmptyState>
    </div>
  )
}
