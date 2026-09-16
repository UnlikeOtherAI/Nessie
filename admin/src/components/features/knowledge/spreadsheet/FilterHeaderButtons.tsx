import { faFilter } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useEffect, useState } from 'react'
import type { Model } from '@ironcalc/wasm'
import { columnIndexToLabel, type SpreadsheetSelection } from '@nessie/schemas'
import { cellRect, HEADER_COLUMN_WIDTH, HEADER_ROW_HEIGHT } from './spreadsheet-geometry'

/**
 * A small funnel button over each column header of a filtered range.
 *
 * IronCalc's canvas is never touched: the buttons are absolutely positioned in
 * a layer over the pane, placed by the same `cellRect` geometry Phase 3b's
 * presence overlay uses, and they sit *in* the column header band so they read
 * as part of the header the way Sheets' do.
 *
 * Two things this has to get right, and both were wrong first:
 *
 *  - `cellRect` answers in the **scroll container's** coordinates, and the
 *    layer is positioned against the pane. The offset between the two is the
 *    toolbar plus the formula bar, so it is measured rather than assumed.
 *  - the container is discovered *after* IronCalc mounts, so it arrives as
 *    state, not as a ref: a ref assignment schedules no render, and the layer
 *    would measure once against `null` and never again.
 *
 * Widths change under a structural batch and the sheet scrolls, so the layer
 * re-measures on scroll, on resize and whenever `revision` changes — the pane
 * bumps that after every applied batch.
 */

type FilterHeaderButtonsProps = {
  activeColumns: ReadonlySet<number>
  /** The positioned element this layer fills; offsets are measured against it. */
  bounds: HTMLElement | null
  /** IronCalc's scroll element, the frame `cellRect` answers in. */
  container: HTMLElement | null
  model: Model | null
  onOpen: (column: number, anchor: HTMLButtonElement) => void
  range: SpreadsheetSelection
  /** Bumped by the pane after every applied batch, to force a re-measure. */
  revision: number
  sheet: number
}

type Placed = { column: number; left: number; top: number }

export const FilterHeaderButtons = ({
  activeColumns,
  bounds,
  container,
  model,
  onOpen,
  range,
  revision,
  sheet,
}: FilterHeaderButtonsProps) => {
  const [placed, setPlaced] = useState<Placed[]>([])

  useEffect(() => {
    if (!model || !container || !bounds) return undefined
    const measure = (): void => {
      const frame = container.getBoundingClientRect()
      const origin = bounds.getBoundingClientRect()
      const dx = frame.left - origin.left
      const dy = frame.top - origin.top
      const next: Placed[] = []
      for (let column = range.c0; column <= range.c1; column += 1) {
        const rect = cellRect(model, sheet, range.r0, column)
        const left = rect.left + rect.width - 18
        // A column narrowed to nothing, scrolled behind the row header, or
        // scrolled off the right edge has nowhere honest to draw a button.
        if (rect.width < 24) continue
        if (left < HEADER_COLUMN_WIDTH || left > frame.width - 4) continue
        next.push({ column, left: dx + left, top: dy + (HEADER_ROW_HEIGHT - 16) / 2 })
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
  }, [bounds, container, model, range.c0, range.c1, range.r0, revision, sheet])

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
              'border',
              active
                ? 'border-[color:var(--accent)] bg-[color:var(--accent)] text-[color:var(--on-accent)]'
                : 'border-[color:var(--sep)] bg-[color:var(--panel)] text-[color:var(--tx3)] hover:text-[color:var(--tx)]',
            ].join(' ')}
            data-testid={`spreadsheet-filter-header-${entry.column}`}
            key={entry.column}
            onClick={(event) => onOpen(entry.column, event.currentTarget)}
            // `fontSize` inline, not a `text-*` utility: the admin's unlayered
            // `button { font: inherit }` reset beats every layered utility, and
            // FontAwesome sizes its svg at `1em`. Left alone the glyph inherits
            // the pane's 15px, fills the 16px box edge to edge and stops
            // reading as a funnel at all -- measured, then looked at.
            style={{ fontSize: 9, left: entry.left, top: entry.top }}
            type="button"
          >
            <FontAwesomeIcon icon={faFilter} />
          </button>
        )
      })}
    </div>
  )
}
