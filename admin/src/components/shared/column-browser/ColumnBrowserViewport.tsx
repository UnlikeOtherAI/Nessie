import {
  Children,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { useViewport } from '../../../hooks/useViewport'
import { useNavigationLayout } from '../../../navigation/mobile-shell'
import { NestedStage, NestedStageHostContext } from '../../../navigation/NestedStage'
import {
  ColumnBackProvider,
  columnBackPriority,
  useLocalBack,
  type ColumnStageReport,
} from '../../../navigation/LocalBackContext'

type ReportBack = ((index: number, report: ColumnStageReport | null) => void) | null

// `ColumnBackProvider`'s value is a fresh object literal at every call site
// (07-F8 item 5): a per-column wrapper memoises it on the two things that
// actually vary, so a re-render of the viewport that changes neither does not
// re-render every column's `useColumnBackContext()` consumer.
const ColumnStageScope = ({
  children,
  index,
  reportBack,
}: {
  children: ReactNode
  index: number | null
  reportBack: ReportBack
}) => {
  const value = useMemo(() => ({ index, reportBack }), [index, reportBack])
  return <ColumnBackProvider value={value}>{children}</ColumnBackProvider>
}

type ColumnBrowserViewportProps = {
  activeColumn: number
  columns: ReactNode[]
  /**
   * A fixed pixel width shared by every column, for a caller whose columns
   * are user-resizable (paired with `ColumnBrowserColumn`'s `resize` prop) —
   * Knowledge's file browser is the one user of this today. Omit it for the
   * default: every other column-browser page splits the viewport evenly
   * across `visibleColumns`. It applies only where this composes the track
   * itself; a stage is a full-width layer and has no column width.
   */
  columnWidth?: number
  // Prefixes the stage ids this viewport pushes. A page that mounts two
  // column browsers passes different scopes so their layers stay distinct in
  // the one stack; a page with a single browser needs nothing.
  stageScope?: string
}

const noop = (): void => undefined

// A column browser on the single layout is not a track: column 0 *is* the
// page, and every column beyond it is a nested stage — a real layer in the
// navigation stack, pushed with the one stack transition and unwound by the
// one Back resolver (docs/navigation/overview.md §6). Where no stack hosts stages —
// a split layout's detail column, a test without a viewport — this composes
// the multi-column track itself, moved on the shared motion tokens.
//
// Only a column knows its own title and unwind action, so it reports
// `{ label, onBack }` up through the column context in a layout effect and
// this viewport owns the single registration: the stage's for a pushed
// column, its own local-back owner for column 0 (a page whose first column
// is itself a Back-owning detail, as Workflows' failed-runs column is).
//
// The page's contract: a column it makes reachable beyond index 0 owns a
// Back (`showBack` + `onBack`). A pushed layer with no way out is a trap,
// and only the page knows the state that closes it.
export const ColumnBrowserViewport = ({
  activeColumn,
  columns,
  columnWidth,
  stageScope,
}: ColumnBrowserViewportProps) => {
  // Column ownership follows the shell's geometry-aware classification, so
  // native Android/iOS tablets keep multiple columns even at a narrow CSS
  // width. Non-phone widths still use the shared viewport bands.
  const { atLeast } = useViewport()
  const layout = useNavigationLayout()
  const stageHost = useContext(NestedStageHostContext)
  const stacked = layout === 'single' && stageHost !== null

  const [reports, setReports] = useState<Record<number, ColumnStageReport>>({})
  // One stable channel for every column: reports are keyed by index, and an
  // unchanged report is dropped so a column re-reporting cannot loop.
  const reportBack = useCallback(
    (index: number, report: ColumnStageReport | null): void => {
      setReports((current) => {
        const existing = current[index]
        if (report === null) {
          if (!existing) return current
          const next = { ...current }
          delete next[index]
          return next
        }
        if (existing?.label === report.label && existing.onBack === report.onBack) {
          return current
        }
        return { ...current, [index]: report }
      })
    },
    [],
  )

  const normalizedColumns = Children.toArray(columns)
  const totalColumns = normalizedColumns.length
  const stageId = (index: number): string =>
    `${stageScope ? `${stageScope}:` : ''}column:${index}`

  // Column 0 is the page, not a layer, so its Back (when it has one) is an
  // ordinary local-back owner rather than a stage.
  const baseReport = reports[0]
  useLocalBack({
    active: stacked && baseReport !== undefined,
    id: stageId(0),
    label: baseReport?.label ?? 'Back',
    onBack: baseReport?.onBack ?? noop,
    priority: columnBackPriority(0),
  })

  if (stacked) {
    return (
      <div className="h-full w-full overflow-clip">
        <ColumnStageScope index={0} reportBack={reportBack}>
          {normalizedColumns[0]}
        </ColumnStageScope>
        {normalizedColumns.slice(1).map((column, offset) => {
          const index = offset + 1
          const report = reports[index]
          return (
            <NestedStage
              active={index <= activeColumn}
              id={stageId(index)}
              key={index}
              label={report?.label ?? 'Back'}
              onBack={report?.onBack ?? noop}
              priority={columnBackPriority(index)}
            >
              <ColumnStageScope index={index} reportBack={reportBack}>
                {column}
              </ColumnStageScope>
            </NestedStage>
          )
        })}
      </div>
    )
  }

  const visibleColumns = atLeast.lg ? 3 : 2
  const columnWidthPercent = 100 / visibleColumns
  const startIndex = Math.max(
    0,
    Math.min(activeColumn - (visibleColumns - 1), totalColumns - visibleColumns),
  )
  // Pixel-based columns shift by an exact pixel offset; percentage-based ones
  // shift by a fraction of the viewport, as every other page already did.
  const translateX = columnWidth
    ? -(startIndex * columnWidth)
    : -(startIndex * columnWidthPercent)
  const translateUnit = columnWidth ? 'px' : '%'

  return (
    <div className="h-full w-full overflow-clip">
      <div
        className="flex h-full"
        data-column-browser-track
        style={{
          transform: `translateX(${translateX}${translateUnit})`,
          transition: 'transform var(--nav-duration) var(--nav-easing)',
        }}
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
          return (
            <div
              className="h-full w-full flex-shrink-0"
              key={index}
              style={{
                width: columnWidth
                  ? `${columnWidth}px`
                  : `${columnWidthPercent * slots}%`,
              }}
            >
              <ColumnStageScope index={index} reportBack={null}>
                {column}
              </ColumnStageScope>
            </div>
          )
        })}
      </div>
    </div>
  )
}
