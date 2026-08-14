import { Children, type ReactNode, useMemo } from 'react'
import { useMediaQuery } from '../../../hooks/useMediaQuery'
import { usePhoneLayout } from '../../../lib/mobile-shell'
import { ColumnBackProvider } from '../../../layouts/admin-shell/local-back/LocalBackContext'

type ColumnBrowserViewportProps = {
  activeColumn: number
  columns: ReactNode[]
}

export const ColumnBrowserViewport = ({
  activeColumn,
  columns,
}: ColumnBrowserViewportProps) => {
  // A phone shell (including the native WebView, whose viewport need not be
  // narrow) shows exactly one column; viewport width alone only classifies
  // mobile-web vs tablet vs desktop.
  const phoneLayout = usePhoneLayout()
  const isTablet = useMediaQuery(
    '(min-width: 768px) and (max-width: 1023px)',
  )
  const isMobile = phoneLayout

  const visibleColumns = isMobile ? 1 : isTablet ? 2 : 3
  const normalizedColumns = Children.toArray(columns)
  const totalColumns = normalizedColumns.length
  // A phone shows exactly one column at a time; the column at the translation
  // origin owns the phone Back doorway. Off-screen columns stay mounted for
  // the slide transition but report phoneVisible: false so their Back
  // registrations deactivate instead of competing for the shell control.
  const phoneVisibleIndex = isMobile ? Math.max(0, Math.min(activeColumn, totalColumns - 1)) : -1

  const translateX = useMemo(() => {
    const columnWidthPercent = 100 / visibleColumns

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

    return -(desktopStartIndex * columnWidthPercent)
  }, [activeColumn, isMobile, totalColumns, visibleColumns])

  return (
    <div className="h-full w-full overflow-hidden">
      <div
        className="flex h-full transition-transform duration-300 ease-out"
        style={{ transform: `translateX(${translateX}%)` }}
      >
        {normalizedColumns.map((column, index) => {
          // The last column absorbs any unused slots so a two-column layout
          // does not leave a dead third of the viewport on desktop.
          const slots =
            index === totalColumns - 1
              ? Math.max(1, visibleColumns - (totalColumns - 1))
              : 1
          return (
            <div
              className="h-full w-full flex-shrink-0"
              key={index}
              style={{ width: `${(100 / visibleColumns) * slots}%` }}
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
