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
import { formatCell, formatNumber, formatTemporal, toneVars } from './widget-format'

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
    <div className="flex h-full flex-col justify-center">
      <div
        className="truncate text-3xl font-semibold tabular-nums"
        style={{ color: toneVars[widget.presentation.tone].text }}
        data-testid="stat-value"
      >
        {value === null ? '—' : formatNumber(value, widget.format)}
      </div>
      {delta !== null ? (
        <div
          className="mt-1 text-xs font-medium"
          style={{ color: improving ? 'var(--success-text)' : 'var(--danger-text)' }}
        >
          {delta >= 0 ? '▲' : '▼'} {formatNumber(Math.abs(delta), { kind: 'percent', precision: 1 })}
        </div>
      ) : null}
      {widget.presentation.detail ? (
        <div className="mt-1 truncate text-xs" style={{ color: 'var(--tx3)' }}>
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
    <div className="h-full overflow-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr>
            {binding.columns.map((column) => (
              <th
                key={column.key}
                className="sticky top-0 truncate px-2 py-1.5 text-left font-medium"
                style={{ background: 'var(--panel)', color: 'var(--tx3)' }}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map((row, index) => (
            <tr key={index} style={{ borderTop: '1px solid var(--sep)' }}>
              {binding.columns.map((column) => (
                <td
                  key={column.key}
                  className="max-w-[240px] truncate px-2 py-1.5 tabular-nums"
                  style={{ color: 'var(--tx2)' }}
                  title={render(column.key, row[column.key] ?? null, column.format)}
                >
                  {render(column.key, row[column.key] ?? null, column.format)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > visible.length ? (
        <div className="px-2 py-1.5 text-[11px]" style={{ color: 'var(--tx3)' }}>
          {rows.length - visible.length} more rows
        </div>
      ) : null}
    </div>
  )
}

const STATE_TONE = {
  ok: { label: 'OK', color: 'var(--success-text)', background: 'var(--success-soft)' },
  warning: { label: 'Warning', color: 'var(--warning-text)', background: 'var(--warning-soft)' },
  failing: { label: 'Failing', color: 'var(--danger-text)', background: 'var(--danger-soft)' },
  unknown: { label: 'Unknown', color: 'var(--tx3)', background: 'var(--overlay-weak)' },
} as const

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
      <span
        className="w-fit rounded px-2 py-1 text-sm font-semibold"
        style={{ background: tone.background, color: tone.color }}
        data-testid="status-state"
      >
        {tone.label}
      </span>
      {since ? (
        <span className="text-xs" style={{ color: 'var(--tx3)' }}>
          since {typeof since === 'string' ? formatTemporal(since) : formatCell(since)}
        </span>
      ) : null}
    </div>
  )
}
