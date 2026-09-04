import { useState, type ReactNode } from 'react'

import { Dialog } from './Dialog'

type ExpandableTableProps = {
  children: ReactNode
  className?: string
  /** The owning product surface deliberately offers a full-screen inspection view. */
  expandable: boolean
  label?: string
}

const ExpandIcon = () => (
  <svg
    aria-hidden="true"
    className="h-4 w-4"
    fill="none"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth="2"
    viewBox="0 0 24 24"
  >
    <path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5" />
  </svg>
)

/**
 * The one viewport for tabular data. It preserves a readable minimum for each
 * column and, where the owning surface opts in, moves the same table into a
 * roomy dialog when a person needs to inspect it, rather than giving each
 * feature a slightly different overflow treatment.
 */
export const ExpandableTable = ({
  children,
  className,
  expandable,
  label = 'Table',
}: ExpandableTableProps) => {
  const [expanded, setExpanded] = useState(false)
  const scrollLabel = `${label}. Scroll horizontally to view all columns.`

  return (
    <div className={['admin-expandable-table', className].filter(Boolean).join(' ')}>
      {expandable ? (
        <button
          aria-label={`Expand ${label}`}
          className="admin-table-expand-button"
          onClick={() => setExpanded(true)}
          title={`Expand ${label}`}
          type="button"
        >
          <ExpandIcon />
        </button>
      ) : null}

      {!expanded ? (
        <div aria-label={scrollLabel} className="admin-expandable-table__viewport" tabIndex={0}>
          {children}
        </div>
      ) : null}

      {expandable ? (
        <Dialog
          description="Scroll horizontally to view all columns."
          onClose={() => setExpanded(false)}
          open={expanded}
          size="full"
          title={label}
        >
          <div className="admin-expandable-table__dialog-content">
            <div aria-label={scrollLabel} className="admin-expandable-table__viewport" tabIndex={0}>
              {children}
            </div>
          </div>
        </Dialog>
      ) : null}
    </div>
  )
}
