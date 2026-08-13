import { Children, type ReactNode, useMemo } from 'react'
import { useMediaQuery } from '../../../hooks/useMediaQuery'
import { usePhoneLayout } from '../../../lib/mobile-shell'

type ColumnBrowserViewportProps = {
  activeColumn: number
  columns: ReactNode[]
}

export const ColumnBrowserViewport = ({
  activeColumn,
  columns,
}: ColumnBrowserViewportProps) => {
  // Column count follows the shell's phone semantics, not a raw width check:
  // a native phone (iPhone/Android, any orientation) is one column; a native
  // tablet (both dimensions ≥ 600) keeps multiple columns like desktop.
  const phoneLayout = usePhoneLayout()
  const isNarrow = useMediaQuery('(max-width: 1023px)')
  const isMobile = phoneLayout
  const isTablet = !phoneLayout && isNarrow

  const visibleColumns = isMobile ? 1 : isTablet ? 2 : 3
  const normalizedColumns = Children.toArray(columns)
  const totalColumns = normalizedColumns.length

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
              {column}
            </div>
          )
        })}
      </div>
    </div>
  )
}
