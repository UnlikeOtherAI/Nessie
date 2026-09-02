import { useCallback, useLayoutEffect, useRef, type ReactNode } from 'react'
import { useScrollMemory } from '../../../hooks/useScrollMemory'
import { PhoneBackButton } from '../../../layouts/admin-shell/PhoneBackButton'
import { PhoneNavigationButton } from '../../../layouts/admin-shell/PhoneNavigationButton'
import { useColumnBackContext } from '../../../layouts/admin-shell/local-back/LocalBackContext'

type ColumnBrowserColumnProps = {
  children: ReactNode
  headerAction?: ReactNode
  leading?: ReactNode
  onBack?: () => void
  // True when this column owns a Back action at all — independent of layout.
  // A column browser that hosts its columns as navigation-stack layers takes
  // that action over the one-way report channel below and registers it once,
  // on the stage; this column then draws the shell's shared leading doorway.
  // Everywhere else (the split layout's multi-column track) the column paints
  // the shared circular Back beside its own title.
  showBack?: boolean
  title: string
  // When set, the column's scroll position is remembered under this key and
  // restored when the column remounts (e.g. after leaving and returning to the
  // section's tab). Must be stable and unique per scroll region.
  scrollKey?: string
}

export const ColumnBrowserColumn = ({
  children,
  headerAction,
  leading,
  onBack,
  showBack,
  title,
  scrollKey,
}: ColumnBrowserColumnProps) => {
  const scroll = useScrollMemory(scrollKey)
  const { index, reportBack } = useColumnBackContext()
  const stacked = reportBack !== null && index !== null
  const backLabel = `Back from ${title}`

  // The report is one-way and stable: the caller's fresh closure lands in a
  // ref, so the effect's dependencies never change with a re-render and the
  // viewport's state cannot loop.
  const backRef = useRef(onBack)
  backRef.current = onBack
  const runBack = useCallback(() => {
    backRef.current?.()
  }, [])
  const hasBack = Boolean(showBack && onBack)

  useLayoutEffect(() => {
    if (!reportBack || index === null || !hasBack) return undefined
    reportBack(index, { label: backLabel, onBack: runBack })
    return () => reportBack(index, null)
  }, [backLabel, hasBack, index, reportBack, runBack])

  return (
    <div className="flex h-full flex-col border-r border-[color:var(--sep)] bg-[color:var(--main)]">
      <div className="flex h-[50px] flex-shrink-0 items-center gap-2 border-b border-[color:var(--sep)] px-4">
        {leading}
        {showBack && onBack
          ? stacked
            ? <PhoneNavigationButton />
            : <PhoneBackButton label={backLabel} onBack={onBack} />
          : null}
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-[color:var(--tx)]">
          {title}
        </h3>
        {headerAction}
      </div>
      <div
        className="flex-1 overflow-y-auto p-3"
        onScroll={scroll.onScroll}
        ref={scroll.ref}
      >
        {children}
      </div>
    </div>
  )
}
