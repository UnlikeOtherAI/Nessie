import { faFilter } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useEffect, useState, type RefObject } from 'react'
import type { Model } from '@ironcalc/wasm'
import { columnIndexToLabel, type SpreadsheetSelection } from '@nessie/schemas'
import { cellRect, HEADER_ROW_HEIGHT } from './spreadsheet-geometry'

/**
 * A small funnel button over each column header of a filtered range.
 *
 * IronCalc's canvas is never touched: the buttons are absolutely positioned in
 * a layer above `.ic-worksheet-sheet-container`, placed by the same `cellRect`
 * geometry Phase 3b's presence overlay uses, and they sit *in* the column
 * header band so they read as part of the header the way Sheets' do.
 *
 * Widths change under a structural batch and the sheet scrolls, so the layer
 * re-measures on scroll, on resize and whenever `revision` changes — the pane
 * bumps that after every applied batch.
 */

type FilterHeaderButtonsProps = {
  activeColumns: ReadonlySet<number>
  /** The scroll element the grid lives in; positions are relative to it. */
  containerRef: RefObject<HTMLElement | null>
  model: Model | null
  onOpen: (column: number, anchor: HTMLButtonElement) => void
  range: SpreadsheetSelection
  /** Bumped by the pane after every applied batch, to force a re-measure. */
  revision: number
  sheet: number
}

type Placed = { column: number; left: number; width: number }

export const FilterHeaderButtons = ({
  activeColumns,
  containerRef,
  model,
  onOpen,
  range,
  revision,
  sheet,
}: FilterHeaderButtonsProps) => {
  const [placed, setPlaced] = useState<Placed[]>([])

  useEffect(() => {
    const container = containerRef.current
    if (!model || !container) return
    const measure = (): void => {
      const next: Placed[] = []
      for (let column = range.c0; column <= range.c1; column += 1) {
        const rect = cellRect(model, sheet, range.r0, column)
        const width = rect.width
        // A column narrowed to nothing (or scrolled behind the row header) has
        // nowhere to draw a button; skipping it is better than a button that
        // floats over the wrong column.
        if (width < 24 || rect.left < 0) continue
        next.push({ column, left: rect.left, width })
      }
      setPlaced(next)
    }
    measure()
    container.addEventListener('scroll', measure, { passive: true })
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => {
      container.removeEventListener('scroll', measure)
      observer.disconnect()
    }
  }, [containerRef, model, range.c0, range.c1, range.r0, revision, sheet])

  if (placed.length === 0) return null

  return (
    <div
      aria-label="Column filters"
      className="pointer-events-none absolute inset-0"
      data-testid="spreadsheet-filter-headers"
    >
      {placed.map((entry) => {
        const active = activeColumns.has(entry.column)
        return (
          <button
            aria-label={`Filter column ${columnIndexToLabel(entry.column)}`}
            aria-pressed={active}
            className={[
              'pointer-events-auto absolute flex h-4 w-4 items-center justify-center rounded-sm',
              'text-[10px] leading-none',
              active
                ? 'bg-[color:var(--accent)] text-[color:var(--on-accent)]'
                : 'bg-[color:var(--panel)] text-[color:var(--tx3)] hover:text-[color:var(--tx)]',
            ].join(' ')}
            data-testid={`spreadsheet-filter-header-${entry.column}`}
            key={entry.column}
            onClick={(event) => onOpen(entry.column, event.currentTarget)}
            style={{
              left: entry.left + entry.width - 18,
              top: (HEADER_ROW_HEIGHT - 16) / 2,
            }}
            type="button"
          >
            <FontAwesomeIcon icon={faFilter} />
          </button>
        )
      })}
    </div>
  )
}
