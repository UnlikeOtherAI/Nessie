/**
 * The chart renderers: timeseries and bar.
 *
 * Recharts renders SVG, and SVG presentation attributes accept `var(--token)`
 * directly — so a theme switch repaints these charts with no JS and no
 * getComputedStyle snapshot to go stale. That is the whole reason this library
 * was chosen over a canvas renderer.
 *
 * Nothing an author wrote reaches Recharts as configuration. The component
 * receives a validated projection and passes only numbers, plain strings, and
 * renderer-owned props; there is no formatter callback, no content prop, and no
 * config spread anywhere in this file.
 */

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type {
  BarWidgetSchema,
  DashboardDataset,
  TimeseriesWidgetSchema,
} from '@nessie/schemas'
import type { z } from 'zod'
import {
  SERIES_TONES,
  formatAxisDate,
  formatNumber,
  toneVars,
} from './widget-format'

type TimeseriesWidget = z.infer<typeof TimeseriesWidgetSchema>
type BarWidget = z.infer<typeof BarWidgetSchema>

const axisStyle = { fill: 'var(--tx3)', fontSize: 11 } as const
const gridStroke = 'var(--sep)'

/**
 * A Nessie-owned tooltip. Recharts' default would render values through its own
 * pipeline; this one renders them as React text nodes with our own formatting,
 * so an external string can never become markup inside a tooltip.
 */
const WidgetTooltip = ({
  active,
  payload,
  label,
}: {
  active?: boolean
  payload?: { name?: string; value?: number | string; color?: string }[]
  label?: string | number
}) => {
  if (!active || !payload?.length) return null
  return (
    <div
      className="rounded border border-[color:var(--sep)] bg-[color:var(--panel)] px-2 py-1.5 text-xs text-[color:var(--tx)] shadow"
    >
      <div className="mb-1 text-[color:var(--tx3)]">
        {String(label ?? '')}
      </div>
      {payload.map((entry, index) => (
        <div key={index} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: entry.color ?? 'var(--tx3)' }}
          />
          <span>{entry.name ?? ''}</span>
          <span className="ml-auto font-medium">{String(entry.value ?? '')}</span>
        </div>
      ))}
    </div>
  )
}

export const TimeseriesWidgetView = ({
  widget,
  dataset,
}: {
  widget: TimeseriesWidget
  dataset: DashboardDataset
}) => {
  const { binding, options, presentation, format } = widget
  const rows = dataset.rows.map((row) => ({
    ...row,
    __x: row[binding.x],
  }))

  const Chart = options.shape === 'area' ? AreaChart : LineChart

  return (
    <ResponsiveContainer height="100%" width="100%">
      <Chart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={gridStroke} strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="__x"
          stroke={gridStroke}
          tick={axisStyle}
          tickFormatter={(value) => formatAxisDate(value as string)}
          tickLine={false}
        />
        <YAxis
          stroke={gridStroke}
          tick={axisStyle}
          tickFormatter={(value) => formatNumber(Number(value), format)}
          tickLine={false}
          width={44}
        />
        <Tooltip content={<WidgetTooltip />} cursor={{ stroke: 'var(--overlay)' }} />
        {presentation.legend !== 'hidden' ? (
          <Legend
            align={presentation.legend === 'right' ? 'right' : 'center'}
            iconSize={8}
            layout={presentation.legend === 'right' ? 'vertical' : 'horizontal'}
            verticalAlign={presentation.legend === 'right' ? 'middle' : 'bottom'}
            wrapperStyle={{ color: 'var(--tx3)', fontSize: 11 }}
          />
        ) : null}
        {binding.series.map((series, index) => {
          const tone = toneVars[SERIES_TONES[index % SERIES_TONES.length] ?? 'accent']
          return options.shape === 'area' ? (
            <Area
              key={series.key}
              dataKey={series.key}
              fill={tone.soft}
              isAnimationActive={false}
              name={series.label}
              stackId={options.stacked ? 'stack' : undefined}
              stroke={tone.line}
              strokeWidth={2}
              type={options.curve}
            />
          ) : (
            <Line
              key={series.key}
              dataKey={series.key}
              dot={false}
              isAnimationActive={false}
              name={series.label}
              stroke={tone.line}
              strokeWidth={2}
              type={options.curve}
            />
          )
        })}
      </Chart>
    </ResponsiveContainer>
  )
}

export const BarWidgetView = ({
  widget,
  dataset,
}: {
  widget: BarWidget
  dataset: DashboardDataset
}) => {
  const { binding, options, presentation, format } = widget
  const primary = binding.series[0]

  // Aggregate by category first. A bar chart answers "how does it split across
  // categories", so plotting one bar per ROW would repeat a category as many
  // times as it appears in the data — which is what a naive pass-through does.
  const grouped = new Map<string, Record<string, number | string>>()
  for (const row of dataset.rows) {
    const category = String(row[binding.category] ?? '—')
    const bucket = grouped.get(category) ?? { [binding.category]: category }
    for (const series of binding.series) {
      const value = row[series.key]
      if (typeof value === 'number') {
        bucket[series.key] = Number(bucket[series.key] ?? 0) + value
      }
    }
    grouped.set(category, bucket)
  }

  const sorted = [...grouped.values()]
  if (binding.sort !== 'source' && primary) {
    sorted.sort((left, right) => {
      if (binding.sort === 'category') {
        return String(left[binding.category] ?? '').localeCompare(
          String(right[binding.category] ?? ''),
        )
      }
      const a = Number(left[primary.key] ?? 0)
      const b = Number(right[primary.key] ?? 0)
      return binding.sort === 'value_asc' ? a - b : b - a
    })
  }
  const rows = sorted.slice(0, binding.limit)
  const horizontal = options.orientation === 'horizontal'

  return (
    <ResponsiveContainer height="100%" width="100%">
      <BarChart
        data={rows}
        layout={horizontal ? 'vertical' : 'horizontal'}
        margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
      >
        <CartesianGrid stroke={gridStroke} strokeDasharray="3 3" horizontal={!horizontal} vertical={horizontal} />
        {horizontal ? (
          <>
            <XAxis
              stroke={gridStroke}
              tick={axisStyle}
              tickFormatter={(value) => formatNumber(Number(value), format)}
              tickLine={false}
              type="number"
            />
            <YAxis
              dataKey={binding.category}
              stroke={gridStroke}
              tick={axisStyle}
              tickLine={false}
              type="category"
              width={96}
            />
          </>
        ) : (
          <>
            <XAxis
              dataKey={binding.category}
              stroke={gridStroke}
              tick={axisStyle}
              tickLine={false}
              type="category"
            />
            <YAxis
              stroke={gridStroke}
              tick={axisStyle}
              tickFormatter={(value) => formatNumber(Number(value), format)}
              tickLine={false}
              type="number"
              width={44}
            />
          </>
        )}
        <Tooltip content={<WidgetTooltip />} cursor={{ fill: 'var(--overlay-weak)' }} />
        {presentation.legend !== 'hidden' && binding.series.length > 1 ? (
          <Legend iconSize={8} wrapperStyle={{ color: 'var(--tx3)', fontSize: 11 }} />
        ) : null}
        {binding.series.map((series, index) => {
          const tone = toneVars[SERIES_TONES[index % SERIES_TONES.length] ?? 'accent']
          return (
            <Bar
              key={series.key}
              dataKey={series.key}
              fill={tone.line}
              isAnimationActive={false}
              name={series.label}
              radius={horizontal ? [0, 3, 3, 0] : [3, 3, 0, 0]}
              stackId={options.stacked ? 'stack' : undefined}
            />
          )
        })}
      </BarChart>
    </ResponsiveContainer>
  )
}
