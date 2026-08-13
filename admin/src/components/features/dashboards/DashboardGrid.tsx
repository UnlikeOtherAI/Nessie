/**
 * The canvas: drag, drop, resize, reflow.
 *
 * This is the ONLY file that imports react-grid-layout. Confining it here keeps
 * the dependency swappable and stops grid concepts leaking into the renderers,
 * which know nothing about layout beyond filling the box they are given.
 *
 * Snapping is always on and every rect is validated server-side against the
 * same size limits, so a drag and an agent's move tool produce layouts from the
 * identical rule set — an agent cannot express a layout a person could not.
 *
 * v2 notes: `WidthProvider` is gone — width comes from the `useContainerWidth`
 * hook and is passed explicitly. The multi-breakpoint map is
 * `ResponsiveLayouts` rather than `Layouts`, compaction is a `compactor`
 * function instead of a `compactType` string, and drag/resize options moved
 * into `dragConfig`/`resizeConfig`.
 */

import { useMemo } from 'react'
import {
  Responsive,
  verticalCompactor,
  type Layout,
  type LayoutItem,
  type ResponsiveLayouts,
} from 'react-grid-layout'
import { useContainerWidth } from 'react-grid-layout/react'
import {
  DASHBOARD_GRID_COLUMNS,
  DASHBOARD_WIDGET_SIZES,
  type DashboardBreakpoint,
  type DashboardLayout,
  type DashboardWidgetKind,
} from '@nessie/schemas'
import 'react-grid-layout/css/styles.css'

export const ROW_HEIGHT = 32
export const GRID_MARGIN: [number, number] = [12, 12]

const BREAKPOINT_PX: Record<DashboardBreakpoint, number> = { lg: 1200, md: 768, sm: 0 }

type DashboardGridProps = {
  layout: DashboardLayout
  widgetKinds: Map<string, DashboardWidgetKind>
  editable: boolean
  onLayoutChange?: (layout: DashboardLayout) => void
  children: React.ReactNode
}

const toGridLayouts = (
  layout: DashboardLayout,
  widgetKinds: Map<string, DashboardWidgetKind>,
): ResponsiveLayouts<DashboardBreakpoint> => {
  const build = (breakpoint: DashboardBreakpoint): Layout =>
    layout[breakpoint].map((rect): LayoutItem => {
      const kind = widgetKinds.get(rect.widgetId)
      const size = kind ? DASHBOARD_WIDGET_SIZES[kind] : undefined
      return {
        i: rect.widgetId,
        x: rect.x,
        y: rect.y,
        w: rect.w,
        h: rect.h,
        ...(size
          ? { minW: size.minW, minH: size.minH, maxW: size.maxW, maxH: size.maxH }
          : {}),
      }
    })
  return { lg: build('lg'), md: build('md'), sm: build('sm') }
}

const fromGridLayouts = (layouts: ResponsiveLayouts<DashboardBreakpoint>): DashboardLayout => {
  const read = (breakpoint: DashboardBreakpoint) =>
    (layouts[breakpoint] ?? []).map((item) => ({
      widgetId: item.i,
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h,
    }))
  return { lg: read('lg'), md: read('md'), sm: read('sm') }
}

export const DashboardGrid = ({
  layout,
  widgetKinds,
  editable,
  onLayoutChange,
  children,
}: DashboardGridProps) => {
  const layouts = useMemo(() => toGridLayouts(layout, widgetKinds), [layout, widgetKinds])
  const { width, containerRef } = useContainerWidth()

  return (
    <div ref={containerRef}>
    <Responsive<DashboardBreakpoint>
      breakpoints={BREAKPOINT_PX}
      className="dashboard-canvas"
      cols={DASHBOARD_GRID_COLUMNS}
      // v2 takes a compactor function rather than a compactType string.
      compactor={verticalCompactor}
      dragConfig={{
        enabled: editable,
        // Dragging is confined to an explicit handle so a click inside a table
        // or a chart tooltip cannot start a drag.
        handle: '.dashboard-widget-handle',
      }}
      layouts={layouts}
      margin={GRID_MARGIN}
      onLayoutChange={(_current, all) => {
        if (!editable || !onLayoutChange) return
        onLayoutChange(fromGridLayouts(all))
      }}
      resizeConfig={{ enabled: editable, handles: ['se', 'e', 's'] }}
      rowHeight={ROW_HEIGHT}
      width={width}
    >
      {children}
    </Responsive>
    </div>
  )
}
