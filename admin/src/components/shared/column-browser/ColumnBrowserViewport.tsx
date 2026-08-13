import { Children, type ReactNode, useMemo } from 'react'
import { useViewport } from '../../../hooks/useViewport'

type ColumnBrowserViewportProps = {
  activeColumn: number
  columns: ReactNode[]
}

export const ColumnBrowserViewport = ({
  activeColumn,
  columns,
}: ColumnBrowserViewportProps) => {
  // Bands derive from minimum-width queries only, so there is no fractional
  // gap between bands: below-md is exactly NOT min-768, and tablet is exactly
  // min-768 AND NOT min-1024. Both come from the shared viewport store's
  // named minimums, so this component cannot drift from the Tailwind scale.
  const { atLeast } = useViewport()
  const isMobile = !atLeast.md
  const isTablet = atLeast.md && !atLeast.lg

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
