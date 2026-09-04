/**
 * The Live Data Dashboards contract
 * (docs/plans/2026-08-13-live-data-dashboards/overview.md §3).
 *
 * This file IS the "no arbitrary code" boundary. An agent authors a widget by
 * emitting one of these objects and nothing else, so the boundary holds by what
 * the schema omits rather than by anything downstream filtering:
 *
 * - there is no `href`, `src`, `action`, `onClick`, or drill-down slot anywhere,
 *   so `javascript:` / `data:` URLs and tracking pixels cannot be expressed;
 * - there is no colour, class, style, or CSS slot — `tone` is an enum the
 *   renderer maps to existing theme custom properties;
 * - there is no formatter function, template string, or chart-library config —
 *   `format` is a closed enum consumed by `Intl`;
 * - every object is `.strict()`, so an unknown key is an error and never an
 *   accidental extension point.
 *
 * Strings in here are DATA. They are rendered as React text nodes and never as
 * markup, so a value like `<img onerror=...>` is inert; it is rejected only for
 * exceeding a length cap, not for looking dangerous.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Caps. Stated once, enforced at write time and again at read time.
// ---------------------------------------------------------------------------

export const DASHBOARD_MAX_COLUMNS = 32
export const DASHBOARD_MAX_ROWS = 2_000
export const DASHBOARD_MAX_PLOTTED_POINTS = 2_000
export const DASHBOARD_MAX_SERIES = 12
export const DASHBOARD_MAX_TABLE_BOUND_ROWS = 500
export const DASHBOARD_MAX_COMPACT_ROWS = 50
export const DASHBOARD_MAX_STRING_CODE_POINTS = 512
export const DASHBOARD_MAX_DATASET_BYTES = 256 * 1024

/** The probe sample an agent sees is capped harder: it needs shape, not data. */
export const DASHBOARD_PROBE_SAMPLE_ROWS = 20
export const DASHBOARD_PROBE_SAMPLE_COLUMNS = 8

export const DASHBOARD_WIDGET_SCHEMA_VERSION = 1
export const DASHBOARD_DATASET_SCHEMA_VERSION = 1

// ---------------------------------------------------------------------------
// Text slots
// ---------------------------------------------------------------------------

const textSlot = (max: number) => z.string().trim().min(1).max(max)
const optionalTextSlot = (max: number) => z.string().trim().max(max).optional()

export const DashboardToneSchema = z.enum([
  'neutral',
  'accent',
  'info',
  'success',
  'warning',
  'danger',
])
export type DashboardTone = z.infer<typeof DashboardToneSchema>

/**
 * The only icons a metric card can name. These are product-owned identifiers,
 * mapped to locally imported Font Awesome Free glyphs by the admin; accepting
 * an arbitrary class, SVG, or package icon would reopen the render boundary.
 */
export const DASHBOARD_METRIC_ICONS = [
  'chart',
  'users',
  'revenue',
  'cart',
  'clock',
  'server',
  'database',
  'bolt',
  'check',
  'warning',
] as const
export const DashboardMetricIconSchema = z.enum(DASHBOARD_METRIC_ICONS)
export type DashboardMetricIcon = z.infer<typeof DashboardMetricIconSchema>

export const WidgetPresentationSchema = z.object({
  style: z.enum(['standard', 'compact', 'emphasis']).default('standard'),
  density: z.enum(['cozy', 'compact']).default('cozy'),
  tone: DashboardToneSchema.default('neutral'),
  title: textSlot(120),
  subtitle: optionalTextSlot(180),
  detail: optionalTextSlot(240),
  caption: optionalTextSlot(240),
  legend: z.enum(['hidden', 'bottom', 'right']).default('hidden'),
  status: z
    .object({
      label: textSlot(40),
      tone: DashboardToneSchema,
    })
    .strict()
    .optional(),
}).strict()
export type WidgetPresentation = z.infer<typeof WidgetPresentationSchema>

// ---------------------------------------------------------------------------
// Formatting — a closed enum, never a format string and never a function.
// ---------------------------------------------------------------------------

export const NumberFormatSchema = z.object({
  kind: z.enum(['number', 'compact_number', 'percent', 'currency', 'duration', 'bytes']),
  precision: z.union([
    z.literal(0), z.literal(1), z.literal(2),
    z.literal(3), z.literal(4), z.literal(5), z.literal(6),
  ]).optional(),
  // ISO 4217. Exactly three ASCII letters, so it cannot smuggle content.
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  unit: z.string().trim().max(8).optional(),
}).strict().superRefine((format, context) => {
  if (format.kind === 'currency' && !format.currency) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'currency format requires an ISO 4217 currency code',
      path: ['currency'],
    })
  }
})
export type NumberFormat = z.infer<typeof NumberFormatSchema>

/**
 * A reference to one column of the source's declared output schema. Validated
 * against that schema at write time — a binding cannot name a field the source
 * does not produce.
 */
export const ColumnKeySchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)

export const DashboardColumnTypeSchema = z.enum(['string', 'number', 'boolean', 'datetime'])
export type DashboardColumnType = z.infer<typeof DashboardColumnTypeSchema>

export const DashboardOutputColumnSchema = z.object({
  key: ColumnKeySchema,
  label: z.string().trim().min(1).max(80),
  type: DashboardColumnTypeSchema,
  nullable: z.boolean().default(false),
}).strict()
export type DashboardOutputColumn = z.infer<typeof DashboardOutputColumnSchema>

export const DashboardOutputColumnsSchema = z
  .array(DashboardOutputColumnSchema)
  .min(1)
  .max(DASHBOARD_MAX_COLUMNS)
  .superRefine((columns, context) => {
    const seen = new Set<string>()
    for (const column of columns) {
      if (seen.has(column.key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate column key: ${column.key}`,
          path: ['columns'],
        })
      }
      seen.add(column.key)
    }
  })

// ---------------------------------------------------------------------------
// Per-kind bindings
// ---------------------------------------------------------------------------

const SeriesBindingSchema = z.object({
  key: ColumnKeySchema,
  label: textSlot(60),
}).strict()

export const StatBindingSchema = z.object({
  value: ColumnKeySchema,
  compareTo: ColumnKeySchema.optional(),
  /** Decides whether an upward delta paints as success or danger. */
  higherIsBetter: z.boolean().default(true),
  spark: ColumnKeySchema.optional(),
}).strict()

export const StatWidgetOptionsSchema = z.object({
  icon: DashboardMetricIconSchema.optional(),
}).strict().default({})

export const TimeseriesBindingSchema = z.object({
  x: ColumnKeySchema,
  series: z.array(SeriesBindingSchema).min(1).max(DASHBOARD_MAX_SERIES),
}).strict()

export const BarBindingSchema = z.object({
  category: ColumnKeySchema,
  series: z.array(SeriesBindingSchema).min(1).max(DASHBOARD_MAX_SERIES),
  sort: z.enum(['value_desc', 'value_asc', 'category', 'source']).default('value_desc'),
  limit: z.number().int().min(1).max(50).default(8),
}).strict()

/** A part-to-whole view: aggregate one value per declared category. */
export const DonutBindingSchema = z.object({
  category: ColumnKeySchema,
  value: ColumnKeySchema,
  sort: z.enum(['value_desc', 'value_asc', 'category', 'source']).default('value_desc'),
  limit: z.number().int().min(1).max(12).default(8),
}).strict()

/** Current value expressed against a target supplied by the same source row. */
export const GaugeBindingSchema = z.object({
  value: ColumnKeySchema,
  target: ColumnKeySchema,
}).strict()

/** A relationship between two quantitative fields, one point per source row. */
export const ScatterBindingSchema = z.object({
  x: ColumnKeySchema,
  y: ColumnKeySchema,
  label: ColumnKeySchema.optional(),
}).strict()

export const TableColumnBindingSchema = z.object({
  key: ColumnKeySchema,
  label: textSlot(80),
  format: NumberFormatSchema.optional(),
}).strict()

export const TableBindingSchema = z.object({
  columns: z.array(TableColumnBindingSchema).min(1).max(DASHBOARD_MAX_COLUMNS),
  sort: z
    .object({ key: ColumnKeySchema, direction: z.enum(['asc', 'desc']) })
    .strict()
    .optional(),
  maxRows: z.number().int().min(1).max(DASHBOARD_MAX_TABLE_BOUND_ROWS).default(50),
}).strict()

/**
 * Health is categorical, so it is its own kind rather than a stat rendering a
 * meaningless "1". `stateMap` maps the source's own vocabulary onto the four
 * states — declared literals, never a pattern match on content.
 */
export const StatusBindingSchema = z.object({
  state: ColumnKeySchema,
  since: ColumnKeySchema.optional(),
  stateMap: z.record(
    z.string().trim().min(1).max(64),
    z.enum(['ok', 'warning', 'failing', 'unknown']),
  ).refine((map) => Object.keys(map).length <= 32, {
    message: 'stateMap accepts at most 32 entries',
  }),
}).strict()

// ---------------------------------------------------------------------------
// The widget definition — a strict discriminated union
// ---------------------------------------------------------------------------

const widgetBase = {
  schemaVersion: z.literal(DASHBOARD_WIDGET_SCHEMA_VERSION),
  sourceId: z.string().uuid(),
  presentation: WidgetPresentationSchema,
}

export const StatWidgetSchema = z.object({
  ...widgetBase,
  kind: z.literal('stat'),
  binding: StatBindingSchema,
  format: NumberFormatSchema.optional(),
  options: StatWidgetOptionsSchema,
}).strict()

export const TimeseriesWidgetSchema = z.object({
  ...widgetBase,
  kind: z.literal('timeseries'),
  binding: TimeseriesBindingSchema,
  format: NumberFormatSchema.optional(),
  options: z.object({
    shape: z.enum(['line', 'area']).default('line'),
    curve: z.enum(['linear', 'monotone', 'step']).default('linear'),
    stacked: z.boolean().default(false),
  }).strict().default({ shape: 'line', curve: 'linear', stacked: false }),
}).strict()

export const BarWidgetSchema = z.object({
  ...widgetBase,
  kind: z.literal('bar'),
  binding: BarBindingSchema,
  format: NumberFormatSchema.optional(),
  options: z.object({
    orientation: z.enum(['horizontal', 'vertical']).default('horizontal'),
    stacked: z.boolean().default(false),
  }).strict().default({ orientation: 'horizontal', stacked: false }),
}).strict()

export const DonutWidgetSchema = z.object({
  ...widgetBase,
  kind: z.literal('donut'),
  binding: DonutBindingSchema,
  format: NumberFormatSchema.optional(),
}).strict()

export const GaugeWidgetSchema = z.object({
  ...widgetBase,
  kind: z.literal('gauge'),
  binding: GaugeBindingSchema,
  format: NumberFormatSchema.optional(),
}).strict()

export const ScatterWidgetSchema = z.object({
  ...widgetBase,
  kind: z.literal('scatter'),
  binding: ScatterBindingSchema,
  format: NumberFormatSchema.optional(),
}).strict()

export const TableWidgetSchema = z.object({
  ...widgetBase,
  kind: z.literal('table'),
  binding: TableBindingSchema,
}).strict()

export const StatusWidgetSchema = z.object({
  ...widgetBase,
  kind: z.literal('status'),
  binding: StatusBindingSchema,
}).strict()

export const WidgetDefinitionSchema = z.discriminatedUnion('kind', [
  StatWidgetSchema,
  TimeseriesWidgetSchema,
  BarWidgetSchema,
  DonutWidgetSchema,
  GaugeWidgetSchema,
  ScatterWidgetSchema,
  TableWidgetSchema,
  StatusWidgetSchema,
])
export type WidgetDefinition = z.infer<typeof WidgetDefinitionSchema>
export type DashboardWidgetKind = WidgetDefinition['kind']

export const DASHBOARD_WIDGET_KINDS: readonly DashboardWidgetKind[] = [
  'stat',
  'timeseries',
  'bar',
  'donut',
  'gauge',
  'scatter',
  'table',
  'status',
] as const

// ---------------------------------------------------------------------------
// The normalized dataset envelope — the only shape that reaches a renderer
// ---------------------------------------------------------------------------

export const DashboardCellSchema = z.union([
  z.string().max(DASHBOARD_MAX_STRING_CODE_POINTS),
  z.number().finite(),
  z.boolean(),
  z.null(),
])
export type DashboardCell = z.infer<typeof DashboardCellSchema>

export const DashboardDatasetSchema = z.object({
  schemaVersion: z.literal(DASHBOARD_DATASET_SCHEMA_VERSION),
  columns: DashboardOutputColumnsSchema,
  rows: z.array(z.record(z.string(), DashboardCellSchema)).max(DASHBOARD_MAX_ROWS),
  fetchedAt: z.string().min(1),
}).strict()
export type DashboardDataset = z.infer<typeof DashboardDatasetSchema>

// ---------------------------------------------------------------------------
// Runtime states, shared by every surface
// ---------------------------------------------------------------------------

export const DashboardWidgetStateSchema = z.enum([
  'loading',
  'empty',
  'fresh',
  'stale',
  'error',
  'denied',
  'unsupported',
])
export type DashboardWidgetState = z.infer<typeof DashboardWidgetStateSchema>

/**
 * What the server sends a browser. Deliberately NOT the agent's tool arguments:
 * the definition has already been validated, the data already normalized and
 * capped, and freshness already resolved server-side.
 */
export const DashboardWidgetProjectionSchema = z.object({
  widgetId: z.string().uuid(),
  dashboardId: z.string().uuid(),
  kind: z.enum(['stat', 'timeseries', 'bar', 'donut', 'gauge', 'scatter', 'table', 'status']),
  schemaVersion: z.number().int(),
  definition: WidgetDefinitionSchema.optional(),
  dataset: DashboardDatasetSchema.optional(),
  state: DashboardWidgetStateSchema,
  /** A stable code, never an upstream message. */
  errorCode: z.string().max(64).optional(),
  fetchedAt: z.string().optional(),
  /** Present only for a frozen snapshot rendering. */
  snapshotId: z.string().uuid().optional(),
  /** "Refreshed using Alice's API access" — the visible half of delegation. */
  authorityLabel: z.string().max(120).optional(),
}).strict()
export type DashboardWidgetProjection = z.infer<typeof DashboardWidgetProjectionSchema>

// ---------------------------------------------------------------------------
// Layout — snapped, so an agent cannot express a layout a person could not drag
// ---------------------------------------------------------------------------

export const DASHBOARD_BREAKPOINTS = ['lg', 'md', 'sm'] as const
export type DashboardBreakpoint = (typeof DASHBOARD_BREAKPOINTS)[number]

export const DASHBOARD_GRID_COLUMNS: Record<DashboardBreakpoint, number> = {
  lg: 12,
  md: 8,
  sm: 4,
}

export const WidgetRectSchema = z.object({
  widgetId: z.string().uuid(),
  x: z.number().int().min(0).max(11),
  y: z.number().int().min(0).max(500),
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(1).max(40),
}).strict()
export type WidgetRect = z.infer<typeof WidgetRectSchema>

export const DashboardLayoutSchema = z.object({
  lg: z.array(WidgetRectSchema).max(50),
  md: z.array(WidgetRectSchema).max(50),
  sm: z.array(WidgetRectSchema).max(50),
}).strict()
export type DashboardLayout = z.infer<typeof DashboardLayoutSchema>

/** Minimum and maximum grid footprint per kind, enforced on every layout write. */
export const DASHBOARD_WIDGET_SIZES: Record<
  DashboardWidgetKind,
  { minW: number; minH: number; maxW: number; maxH: number }
> = {
  stat: { minW: 3, minH: 3, maxW: 12, maxH: 8 },
  status: { minW: 3, minH: 2, maxW: 12, maxH: 6 },
  timeseries: { minW: 4, minH: 5, maxW: 12, maxH: 20 },
  bar: { minW: 4, minH: 5, maxW: 12, maxH: 20 },
  donut: { minW: 4, minH: 5, maxW: 8, maxH: 16 },
  gauge: { minW: 3, minH: 4, maxW: 6, maxH: 12 },
  scatter: { minW: 4, minH: 5, maxW: 12, maxH: 20 },
  table: { minW: 6, minH: 5, maxW: 12, maxH: 30 },
}
