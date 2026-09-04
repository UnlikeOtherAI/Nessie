/**
 * The one widget renderer, parameterised by surface.
 *
 * The canvas, a chat message and a knowledge page all mount this component —
 * Rule zero §4: one thing shown in three places is one component with a
 * `surface` prop, never three implementations that drift.
 *
 * It renders a server-built projection. It never fetches, never formats a URL,
 * and never receives an author's configuration; every state that cannot produce
 * trustworthy output resolves to a placeholder rather than partial output.
 */

import { lazy, Suspense } from 'react'
import type { DashboardWidgetProjection } from '@nessie/schemas'
import { WidgetFrame, WidgetPlaceholder, WidgetSkeleton } from './WidgetFrame'
import { StatWidgetView, StatusWidgetView, TableWidgetView } from './WidgetPanels'

// The chart bundle is lazy: a dashboard list, or a page of stat and table
// widgets, never pays for Recharts.
const WidgetCharts = lazy(async () => {
  const module = await import('./WidgetCharts')
  return {
    default: ({ projection }: { projection: DashboardWidgetProjection }) => {
      const definition = projection.definition
      const dataset = projection.dataset
      if (!definition || !dataset) return null
      if (definition.kind === 'timeseries') {
        return <module.TimeseriesWidgetView dataset={dataset} widget={definition} />
      }
      if (definition.kind === 'bar') {
        return <module.BarWidgetView dataset={dataset} widget={definition} />
      }
      return null
    },
  }
})

const WidgetAdditionalCharts = lazy(async () => {
  const module = await import('./WidgetAdditionalCharts')
  return {
    default: ({ projection }: { projection: DashboardWidgetProjection }) => {
      const definition = projection.definition
      const dataset = projection.dataset
      if (!definition || !dataset) return null
      switch (definition.kind) {
        case 'donut':
          return <module.DonutWidgetView dataset={dataset} widget={definition} />
        case 'gauge':
          return <module.GaugeWidgetView dataset={dataset} widget={definition} />
        case 'scatter':
          return <module.ScatterWidgetView dataset={dataset} widget={definition} />
        default:
          return null
      }
    },
  }
})

export type WidgetSurface = 'dashboard' | 'message' | 'knowledge'

type DashboardWidgetCardProps = {
  projection: DashboardWidgetProjection
  surface?: WidgetSurface
  onRetry?: () => void
}

const WidgetBody = ({ projection }: { projection: DashboardWidgetProjection }) => {
  const { state, definition, dataset } = projection

  if (state === 'denied') {
    return (
      <WidgetPlaceholder
        detail="Ask the dashboard's owner for access."
        title="You can't see this data"
      />
    )
  }
  if (state === 'unsupported') {
    return (
      <WidgetPlaceholder
        detail="This widget version needs an administrator update."
        title="Can't display this widget"
        tone="warning"
      />
    )
  }
  if (state === 'loading') return <WidgetSkeleton />
  if (state === 'error' && !dataset) {
    return <WidgetPlaceholder title="Data unavailable" tone="danger" />
  }
  if (state === 'empty') {
    return <WidgetPlaceholder detail="The last refresh returned no rows." title="No data returned" />
  }
  if (!definition || !dataset) return <WidgetSkeleton />

  switch (definition.kind) {
    case 'stat':
      return <StatWidgetView dataset={dataset} widget={definition} />
    case 'table':
      return <TableWidgetView dataset={dataset} widget={definition} />
    case 'status':
      return <StatusWidgetView dataset={dataset} widget={definition} />
    case 'timeseries':
    case 'bar':
      return (
        <Suspense fallback={<WidgetSkeleton />}>
          <WidgetCharts projection={projection} />
        </Suspense>
      )
    case 'donut':
    case 'gauge':
    case 'scatter':
      return (
        <Suspense fallback={<WidgetSkeleton />}>
          <WidgetAdditionalCharts projection={projection} />
        </Suspense>
      )
    default:
      return <WidgetPlaceholder title="Can't display this widget" tone="warning" />
  }
}

export const DashboardWidgetCard = ({
  projection,
  surface = 'dashboard',
  onRetry,
}: DashboardWidgetCardProps) => {
  const isStale = projection.state === 'stale'
  return (
    <WidgetFrame
      compact={surface !== 'dashboard'}
      {...(projection.definition ? { presentation: projection.definition.presentation } : {})}
      {...(onRetry ? { onRetry } : {})}
      projection={projection}
    >
      {/* Staleness desaturates the plot, never the frame or the footer: the
          numbers stay readable while the widget admits how old they are. */}
      <div className="h-full" style={isStale ? { opacity: 0.75 } : undefined}>
        <WidgetBody projection={projection} />
      </div>
    </WidgetFrame>
  )
}
