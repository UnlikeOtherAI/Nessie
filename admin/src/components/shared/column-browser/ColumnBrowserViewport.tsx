import { Children, type ReactNode, useMemo } from 'react'
import { useViewport } from '../../../hooks/useViewport'
import { usePhoneLayout } from '../../../lib/mobile-shell'
import { ColumnBackProvider } from '../../../layouts/admin-shell/local-back/LocalBackContext'

type ColumnBrowserViewportProps = {
  activeColumn: number
  columns: ReactNode[]
  /**
   * A fixed pixel width shared by every column, for a caller whose columns
   * are user-resizable (paired with `ColumnBrowserColumn`'s `resize` prop) —
   * Knowledge's file browser is the one user of this today. Omit it for the
   * default: every other column-browser page splits the viewport evenly
   * across `visibleColumns`, which stays the behaviour here too.
   */
  columnWidth?: number
}

export const ColumnBrowserViewport = ({
  activeColumn,
  columns,
  columnWidth,
}: ColumnBrowserViewportProps) => {
  // Phone ownership follows the shell's geometry-aware classification, so
  // native Android/iOS tablets keep multiple columns even at a narrow CSS
  // width. Non-phone widths still use the shared viewport bands.
  const { atLeast } = useViewport()
  const phoneLayout = usePhoneLayout()
  const isMobile = phoneLayout
  const isTablet = !phoneLayout && !atLeast.lg

  const visibleColumns = isMobile ? 1 : isTablet ? 2 : 3
  const normalizedColumns = Children.toArray(columns)
  const totalColumns = normalizedColumns.length
  // A phone shows exactly one column at a time; the column at the translation
  // origin owns the phone Back doorway. Off-screen columns stay mounted for
  // the slide transition but report phoneVisible: false so their Back
  // registrations deactivate instead of competing for the shell control.
  const phoneVisibleIndex = isMobile ? Math.max(0, Math.min(activeColumn, totalColumns - 1)) : -1

  const translateX = useMemo(() => {
    if (isMobile) {
      return -(activeColumn * 100)
    }

    const desktopStartIndex = Math.max(
      0,
      Math.min(
        activeColumn - (visibleColumns - 1),
        totalColumns - visibleColumns,
      ),
    )

    // Pixel-based columns shift by an exact pixel offset (`translateX` then
    // carries a `px` unit below); percentage-based ones shift by a fraction
    // of the viewport, as every other column-browser page already did.
    if (columnWidth) return -(desktopStartIndex * columnWidth)
    return -(desktopStartIndex * (100 / visibleColumns))
  }, [activeColumn, columnWidth, isMobile, totalColumns, visibleColumns])
  const translateUnit = !isMobile && columnWidth ? 'px' : '%'

  return (
    <div className="h-full w-full overflow-hidden">
      <div
        className="flex h-full transition-transform duration-300 ease-out"
        style={{ transform: `translateX(${translateX}${translateUnit})` }}
      >
        {normalizedColumns.map((column, index) => {
          // The last column absorbs any unused slots so a two-column layout
          // does not leave a dead third of the viewport on desktop — only
          // meaningful for the percentage split; pixel-width columns are
          // sized by the caller's own resizable width instead.
          const slots =
            index === totalColumns - 1
              ? Math.max(1, visibleColumns - (totalColumns - 1))
              : 1
          const phoneHidden = isMobile && index !== phoneVisibleIndex
          return (
            <div
              aria-hidden={phoneHidden || undefined}
              className="h-full w-full flex-shrink-0"
              inert={phoneHidden || undefined}
              key={index}
              style={{
                width:
                  !isMobile && columnWidth
                    ? `${columnWidth}px`
                    : `${(100 / visibleColumns) * slots}%`,
              }}
            >
              <ColumnBackProvider
                value={{ index, phoneVisible: index === phoneVisibleIndex }}
              >
                {column}
              </ColumnBackProvider>
            </div>
          )
        })}
      </div>
    </div>
  )
}
