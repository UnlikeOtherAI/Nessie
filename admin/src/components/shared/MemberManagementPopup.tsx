import { useCallback, useId, useRef, type ReactNode } from 'react'

import { CloseIcon, SearchIcon } from './channel-members/icons'
import { useModalA11y } from './useModalA11y'
import { useOverlayDismiss } from './useOverlayDismiss'

type MemberManagementPopupProps = {
  children: ReactNode
  entityLabel: string
  onClose: () => void
  onSearchChange: (value: string) => void
  search: string
  totalMembers: number
}

/**
 * The shared people-management surface for channels and projects. Each host
 * owns its membership data and authorization, while this shell keeps the
 * modal, search, count, and dismissal behaviour visibly identical.
 */
export const MemberManagementPopup = ({
  children,
  entityLabel,
  onClose,
  onSearchChange,
  search,
  totalMembers,
}: MemberManagementPopupProps) => {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const titleId = useId()
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const requestClose = useCallback(() => onCloseRef.current(), [])
  useModalA11y(panelRef, requestClose, true, searchInputRef)
  const overlayDismiss = useOverlayDismiss(requestClose)

  return (
    <div
      {...overlayDismiss}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--scrim-strong)',
        backdropFilter: 'blur(4px)',
      }}
    >
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className={[
          'flex max-h-[80vh] w-[calc(100%-1.5rem)] max-w-[480px] flex-col rounded-xl',
          'border border-[color:var(--sep)] bg-[color:var(--main)]',
        ].join(' ')}
        ref={panelRef}
        role="dialog"
        style={{ boxShadow: '0 24px 48px var(--scrim-strong)' }}
        tabIndex={-1}
      >
        <div className="flex items-center justify-between border-b border-[color:var(--sep)] px-5 py-4">
          <div>
            <h2 className="text-lg font-bold text-[color:var(--tx)]" id={titleId}>
              {entityLabel} members
            </h2>
            <p className="mt-0.5 text-xs text-[color:var(--tx3)]">
              {totalMembers} member{totalMembers !== 1 ? 's' : ''}
            </p>
          </div>
          <button
            className={[
              'flex h-7 w-7 items-center justify-center rounded',
              'text-[color:var(--tx3)] hover:bg-[color:var(--overlay)]',
              'hover:text-[color:var(--tx)]',
            ].join(' ')}
            aria-label="Close"
            onClick={requestClose}
            type="button"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="border-b border-[color:var(--sep)] px-5 py-3">
          <div
            className={[
              'flex items-center gap-2 rounded-lg border',
              'border-[color:var(--border-strong)] bg-[color:var(--overlay-weak)] px-3 py-2',
            ].join(' ')}
          >
            <SearchIcon />
            <input
              autoFocus
              className={[
                'w-full bg-transparent text-sm text-[color:var(--tx)] outline-none',
                'placeholder:text-[color:var(--tx3)]',
              ].join(' ')}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Search members or agents..."
              ref={searchInputRef}
              value={search}
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {children}
        </div>
      </div>
    </div>
  )
}
