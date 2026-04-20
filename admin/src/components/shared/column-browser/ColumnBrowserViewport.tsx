import { Children, type ReactNode, useMemo } from 'react'
import { useMediaQuery } from '../../../hooks/useMediaQuery'

type ColumnBrowserViewportProps = {
  activeColumn: number
  columns: ReactNode[]
}

export const ColumnBrowserViewport = ({
  activeColumn,
  columns,
}: ColumnBrowserViewportProps) => {
  const isMobile = useMediaQuery('(max-width: 767px)')
  const isTablet = useMediaQuery(
    '(min-width: 768px) and (max-width: 1023px)',
  )

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
        {normalizedColumns.map((column, index) => (
          <div
            className="h-full w-full flex-shrink-0"
            key={index}
            style={{ width: `${100 / visibleColumns}%` }}
          >
            {column}
          </div>
        ))}
      </div>
    </div>
  )
}
