/**
 * Additional closed dashboard charts: composition, target progress, and
 * correlation. They receive typed widget definitions and normalized datasets
 * only—never a chart-library configuration written by a dashboard author.
 */

import {
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type {
  DashboardDataset,
  DonutWidgetSchema,
  GaugeWidgetSchema,
  ScatterWidgetSchema,
} from '@nessie/schemas'
import type { z } from 'zod'
import { aggregateCategories, sortCategories } from './dashboard-chart-data'
import { WidgetTooltip } from './WidgetCharts'
import {
  SERIES_TONES,
  formatNumber,
  toneVars,
} from './widget-format'

type DonutWidget = z.infer<typeof DonutWidgetSchema>
type GaugeWidget = z.infer<typeof GaugeWidgetSchema>
type ScatterWidget = z.infer<typeof ScatterWidgetSchema>

const axisStyle = { fill: 'var(--tx3)', fontSize: 11 } as const
const gridStroke = 'var(--sep)'

export const DonutWidgetView = ({
  widget,
  dataset,
}: {
  widget: DonutWidget
  dataset: DashboardDataset
}) => {
  const { binding, presentation } = widget
  const rows = sortCategories(
    aggregateCategories(dataset, binding.category, [binding.value]),
    binding.category,
    binding.value,
    binding.sort,
  )
    .filter((row) => Number(row[binding.value] ?? 0) > 0)
    .slice(0, binding.limit)

  if (rows.length === 0) {
    return (
      <div
        className="flex h-full items-center justify-center text-center text-xs text-[color:var(--tx3)]"
        data-testid="donut-empty"
      >
        No positive values to show
      </div>
    )
  }

  return (
    <ResponsiveContainer height="100%" width="100%">
      <PieChart>
        <Pie
          cornerRadius={3}
          data={rows}
          dataKey={binding.value}
          innerRadius="55%"
          isAnimationActive={false}
          nameKey={binding.category}
          outerRadius="82%"
          paddingAngle={1}
        >
          {rows.map((row, index) => {
            const tone = toneVars[SERIES_TONES[index % SERIES_TONES.length] ?? 'accent']
            return <Cell fill={tone.line} key={String(row[binding.category])} />
          })}
        </Pie>
        <Tooltip content={<WidgetTooltip />} />
        {presentation.legend !== 'hidden' ? (
          <Legend
            iconSize={8}
            layout={presentation.legend === 'right' ? 'vertical' : 'horizontal'}
            verticalAlign={presentation.legend === 'right' ? 'middle' : 'bottom'}
            wrapperStyle={{ color: 'var(--tx3)', fontSize: 11 }}
          />
        ) : null}
      </PieChart>
    </ResponsiveContainer>
  )
}

/** The newest row is the current measurement, as it is for a stat card. */
const latestRow = (dataset: DashboardDataset) => dataset.rows[dataset.rows.length - 1]

export const GaugeWidgetView = ({
  widget,
  dataset,
}: {
  widget: GaugeWidget
  dataset: DashboardDataset
}) => {
  const row = latestRow(dataset)
  const value = typeof row?.[widget.binding.value] === 'number'
    ? row[widget.binding.value] as number
    : null
  const target = typeof row?.[widget.binding.target] === 'number'
    ? row[widget.binding.target] as number
    : null
  const ratio = value !== null && target !== null && target > 0
    ? Math.max(0, Math.min(value / target, 1))
    : null
  const tone = toneVars[widget.presentation.tone]

  return (
    <div className="flex h-full flex-col items-center justify-center" data-testid="gauge-value">
      <svg
        aria-label={ratio === null ? 'No positive target' : `${Math.round(ratio * 100)} percent of target`}
        className="h-auto w-full max-w-[180px]"
        role="img"
        viewBox="0 0 160 102"
      >
        <path
          d="M20 82 A60 60 0 0 1 140 82"
          fill="none"
          pathLength="100"
          stroke="var(--overlay)"
          strokeLinecap="round"
          strokeWidth="14"
        />
        {ratio !== null ? (
          <path
            d="M20 82 A60 60 0 0 1 140 82"
            fill="none"
            pathLength="100"
            stroke={tone.line}
            strokeDasharray={`${Math.round(ratio * 100)} 100`}
            strokeLinecap="round"
            strokeWidth="14"
          />
        ) : null}
        <text
          fill="var(--tx)"
          fontSize="25"
          fontWeight="600"
          textAnchor="middle"
          x="80"
          y="72"
        >
          {value === null ? '—' : formatNumber(value, widget.format)}
        </text>
        <text fill="var(--tx3)" fontSize="10" textAnchor="middle" x="80" y="91">
          {target !== null ? `of ${formatNumber(target, widget.format)}` : 'No target'}
        </text>
      </svg>
      {ratio !== null ? (
        <span className="mt-1 text-xs font-medium text-[color:var(--tx2)]">
          {formatNumber(ratio, { kind: 'percent', precision: 0 })} of target
        </span>
      ) : null}
    </div>
  )
}

export const ScatterWidgetView = ({
  widget,
  dataset,
}: {
  widget: ScatterWidget
  dataset: DashboardDataset
}) => {
  const rows = dataset.rows.flatMap((row, index) => {
    const x = row[widget.binding.x]
    const y = row[widget.binding.y]
    if (typeof x !== 'number' || typeof y !== 'number') return []
    return [{
      id: index,
      x,
      y,
      ...(widget.binding.label ? { label: String(row[widget.binding.label] ?? '—') } : {}),
    }]
  })
  const tone = toneVars[widget.presentation.tone]

  return (
    <ResponsiveContainer height="100%" width="100%">
      <ScatterChart margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={gridStroke} strokeDasharray="3 3" />
        <XAxis
          dataKey="x"
          name={widget.binding.x}
          stroke={gridStroke}
          tick={axisStyle}
          tickFormatter={(value) => formatNumber(Number(value), widget.format)}
          tickLine={false}
          type="number"
        />
        <YAxis
          dataKey="y"
          name={widget.binding.y}
          stroke={gridStroke}
          tick={axisStyle}
          tickFormatter={(value) => formatNumber(Number(value), widget.format)}
          tickLine={false}
          type="number"
          width={44}
        />
        <Tooltip content={<WidgetTooltip />} cursor={{ stroke: 'var(--overlay)' }} />
        <Scatter data={rows} fill={tone.line} isAnimationActive={false} name={widget.presentation.title} />
      </ScatterChart>
    </ResponsiveContainer>
  )
}
