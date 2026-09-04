/**
 * The non-chart renderers: stat, table, status.
 *
 * Every value is a React text node. There is no `dangerouslySetInnerHTML`, no
 * Markdown, and no cell rendered as a link or an image — a value that looks
 * like a URL stays text, because the contract has no href slot to put it in.
 */

import type {
  DashboardDataset,
  StatWidgetSchema,
  StatusWidgetSchema,
  TableWidgetSchema,
} from '@nessie/schemas'
import type { z } from 'zod'
import { Pill, type PillTone } from '../../primitives/Pill'
import { ExpandableTable } from '../../shared/ExpandableTable'
import { DashboardMetricIcon } from './DashboardMetricIcon'
import { formatCell, formatNumber, formatTemporal, toneTextClass } from './widget-format'

type StatWidget = z.infer<typeof StatWidgetSchema>
type TableWidget = z.infer<typeof TableWidgetSchema>
type StatusWidget = z.infer<typeof StatusWidgetSchema>

/** The newest row is the current value; a stat reads the tail of a series. */
const latestRow = (dataset: DashboardDataset) => dataset.rows[dataset.rows.length - 1]

export const StatWidgetView = ({
  widget,
  dataset,
}: {
  widget: StatWidget
  dataset: DashboardDataset
}) => {
  const row = latestRow(dataset)
  const value = typeof row?.[widget.binding.value] === 'number'
    ? (row[widget.binding.value] as number)
    : null
  const previous = widget.binding.compareTo && typeof row?.[widget.binding.compareTo] === 'number'
    ? (row[widget.binding.compareTo] as number)
    : null

  const delta = value !== null && previous !== null && previous !== 0
    ? (value - previous) / Math.abs(previous)
    : null

  // Direction-goodness, not raw sign: a fall in error rate is good news, and
  // painting it red would be actively misleading.
  const improving = delta === null
    ? null
    : widget.binding.higherIsBetter
      ? delta >= 0
      : delta <= 0

  return (
    <div className="relative flex h-full flex-col justify-center">
      {widget.options.icon ? (
        <span
          aria-label={`${widget.options.icon} metric`}
          className="absolute right-0 top-0 flex h-8 w-8 items-center justify-center rounded-full bg-[color:var(--overlay-weak)] text-[color:var(--tx3)]"
          data-testid="stat-icon"
        >
          <DashboardMetricIcon className="h-3.5 w-3.5" icon={widget.options.icon} />
        </span>
      ) : null}
      <div
        className={[
          'truncate text-3xl font-semibold tabular-nums',
          toneTextClass[widget.presentation.tone],
        ].join(' ')}
        data-testid="stat-value"
      >
        {value === null ? '—' : formatNumber(value, widget.format)}
      </div>
      {delta !== null ? (
        <div
          className={[
            'mt-1 text-xs font-medium',
            improving ? 'text-[color:var(--success-text)]' : 'text-[color:var(--danger-text)]',
          ].join(' ')}
        >
          {delta >= 0 ? '▲' : '▼'} {formatNumber(Math.abs(delta), { kind: 'percent', precision: 1 })}
        </div>
      ) : null}
      {widget.presentation.detail ? (
        <div className="mt-1 truncate text-xs text-[color:var(--tx3)]">
          {widget.presentation.detail}
        </div>
      ) : null}
    </div>
  )
}

export const TableWidgetView = ({
  widget,
  dataset,
}: {
  widget: TableWidget
  dataset: DashboardDataset
}) => {
  const { binding } = widget
  // A datetime column renders as a readable date, not a raw ISO string. The
  // declared column type is what decides — the author picks no format for it.
  const columnTypes = new Map(dataset.columns.map((column) => [column.key, column.type]))
  const render = (key: string, value: Parameters<typeof formatCell>[0], format?: Parameters<typeof formatCell>[1]) =>
    columnTypes.get(key) === 'datetime' && typeof value === 'string'
      ? formatTemporal(value)
      : formatCell(value, format)
  const rows = [...dataset.rows]
  if (binding.sort) {
    const { key, direction } = binding.sort
    rows.sort((left, right) => {
      const a = left[key]
      const b = right[key]
      if (typeof a === 'number' && typeof b === 'number') {
        return direction === 'asc' ? a - b : b - a
      }
      const result = String(a ?? '').localeCompare(String(b ?? ''))
      return direction === 'asc' ? result : -result
    })
  }
  const visible = rows.slice(0, binding.maxRows)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ExpandableTable
        className="min-h-0 flex-1"
        expandable
        label={widget.presentation.title ?? 'Dashboard table'}
      >
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr>
              {binding.columns.map((column) => (
                <th
                  key={column.key}
                  className="sticky top-0 truncate bg-[color:var(--panel)] px-2 py-1.5 text-left font-medium text-[color:var(--tx3)]"
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, index) => (
              <tr className="border-t border-[color:var(--sep)]" key={index}>
                {binding.columns.map((column) => (
                  <td
                    key={column.key}
                    className="max-w-[240px] truncate px-2 py-1.5 tabular-nums text-[color:var(--tx2)]"
                    title={render(column.key, row[column.key] ?? null, column.format)}
                  >
                    {render(column.key, row[column.key] ?? null, column.format)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </ExpandableTable>
      {rows.length > visible.length ? (
        <div className="px-2 py-1.5 text-[11px] text-[color:var(--tx3)]">
          {rows.length - visible.length} more rows
        </div>
      ) : null}
    </div>
  )
}

const STATE_TONE: Record<'ok' | 'warning' | 'failing' | 'unknown', { label: string; tone: PillTone }> = {
  ok: { label: 'OK', tone: 'success' },
  warning: { label: 'Warning', tone: 'warning' },
  failing: { label: 'Failing', tone: 'danger' },
  unknown: { label: 'Unknown', tone: 'muted' },
}

export const StatusWidgetView = ({
  widget,
  dataset,
}: {
  widget: StatusWidget
  dataset: DashboardDataset
}) => {
  const row = latestRow(dataset)
  const raw = row?.[widget.binding.state]
  // Mapped through the author's declared vocabulary — a lookup, never a guess
  // at what a value means.
  const mapped = raw === null || raw === undefined
    ? 'unknown'
    : (widget.binding.stateMap[String(raw)] ?? 'unknown')
  const tone = STATE_TONE[mapped]
  const since = widget.binding.since ? row?.[widget.binding.since] : null

  return (
    <div className="flex h-full flex-col justify-center gap-1.5">
      <span className="w-fit" data-testid="status-state">
        <Pill radius="chip" tone={tone.tone} uppercase={false}>
          {tone.label}
        </Pill>
      </span>
      {since ? (
        <span className="text-xs text-[color:var(--tx3)]">
          since {typeof since === 'string' ? formatTemporal(since) : formatCell(since)}
        </span>
      ) : null}
    </div>
  )
}
