import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DASHBOARD_WIDGET_SCHEMA_VERSION,
  WidgetDefinitionSchema,
  validateWidgetBinding,
  type DashboardOutputColumn,
} from '../index.js'

const SOURCE_ID = '3f1c9d2e-1b4a-4f0e-9c2d-8a7b6c5d4e3f'

const columns: DashboardOutputColumn[] = [
  { key: 'observed_at', label: 'Observed', type: 'datetime', nullable: false },
  { key: 'successful', label: 'Succeeded', type: 'number', nullable: false },
  { key: 'failed', label: 'Failed', type: 'number', nullable: false },
  { key: 'region', label: 'Region', type: 'string', nullable: false },
]

const presentation = { title: 'Requests per day' }

const timeseries = {
  kind: 'timeseries' as const,
  schemaVersion: DASHBOARD_WIDGET_SCHEMA_VERSION,
  sourceId: SOURCE_ID,
  presentation,
  binding: {
    x: 'observed_at',
    series: [{ key: 'successful', label: 'Succeeded' }],
  },
}

test('accepts a well-formed timeseries widget and applies presentation defaults', () => {
  const parsed = WidgetDefinitionSchema.safeParse(timeseries)
  assert.equal(parsed.success, true)
  assert.ok(parsed.success)
  assert.equal(parsed.data.presentation.tone, 'neutral')
  assert.equal(parsed.data.presentation.style, 'standard')
  assert.equal(parsed.data.kind === 'timeseries' && parsed.data.options.shape, 'line')
})

test('rejects an unknown key rather than ignoring it', () => {
  const parsed = WidgetDefinitionSchema.safeParse({
    ...timeseries,
    binding: {
      x: 'observed_at',
      series: [{ key: 'successful', label: 'Succeeded', formatJs: 'd => d * 2' }],
    },
  })
  assert.equal(parsed.success, false)
})

test('rejects an authored colour — tone is the only colour affordance', () => {
  const parsed = WidgetDefinitionSchema.safeParse({
    ...timeseries,
    presentation: { ...presentation, titleColor: '#ff0000' },
  })
  assert.equal(parsed.success, false)
})

test('there is no actions/href slot at all, so a javascript: URL cannot be expressed', () => {
  const parsed = WidgetDefinitionSchema.safeParse({
    ...timeseries,
    actions: [{ label: 'go', href: "javascript:fetch('/api/admin')" }],
  })
  assert.equal(parsed.success, false)
})

test('a markup-looking title is DATA and passes — it is rendered as a text node', () => {
  const parsed = WidgetDefinitionSchema.safeParse({
    ...timeseries,
    presentation: { title: '<img src=x onerror=alert(1)>' },
  })
  assert.equal(parsed.success, true)
})

test('rejects a title beyond the length cap', () => {
  const parsed = WidgetDefinitionSchema.safeParse({
    ...timeseries,
    presentation: { title: 'x'.repeat(121) },
  })
  assert.equal(parsed.success, false)
})

test('rejects more series than the cap allows', () => {
  const parsed = WidgetDefinitionSchema.safeParse({
    ...timeseries,
    binding: {
      x: 'observed_at',
      series: Array.from({ length: 13 }, (_, index) => ({
        key: 'successful',
        label: `Series ${index}`,
      })),
    },
  })
  assert.equal(parsed.success, false)
})

test('currency format demands a currency code', () => {
  const parsed = WidgetDefinitionSchema.safeParse({
    kind: 'stat',
    schemaVersion: DASHBOARD_WIDGET_SCHEMA_VERSION,
    sourceId: SOURCE_ID,
    presentation: { title: 'MRR' },
    binding: { value: 'successful' },
    format: { kind: 'currency' },
  })
  assert.equal(parsed.success, false)
})

test('accepts the closed metric-card icon vocabulary and defaults its options', () => {
  const withIcon = WidgetDefinitionSchema.safeParse({
    kind: 'stat',
    schemaVersion: DASHBOARD_WIDGET_SCHEMA_VERSION,
    sourceId: SOURCE_ID,
    presentation: { title: 'Active users' },
    binding: { value: 'successful' },
    options: { icon: 'users' },
  })
  const withoutIcon = WidgetDefinitionSchema.safeParse({
    kind: 'stat',
    schemaVersion: DASHBOARD_WIDGET_SCHEMA_VERSION,
    sourceId: SOURCE_ID,
    presentation: { title: 'Active users' },
    binding: { value: 'successful' },
  })

  assert.equal(withIcon.success, true)
  assert.equal(withoutIcon.success, true)
  assert.ok(withoutIcon.success)
  assert.equal(withoutIcon.data.kind, 'stat')
  assert.deepEqual(withoutIcon.data.options, {})
})

test('refuses an arbitrary metric-card icon identifier', () => {
  const parsed = WidgetDefinitionSchema.safeParse({
    kind: 'stat',
    schemaVersion: DASHBOARD_WIDGET_SCHEMA_VERSION,
    sourceId: SOURCE_ID,
    presentation: { title: 'Active users' },
    binding: { value: 'successful' },
    options: { icon: 'faCustomSvg' },
  })
  assert.equal(parsed.success, false)
})

test('accepts the additional composition, target, and correlation widgets', () => {
  const definitions = [
    {
      kind: 'donut' as const,
      schemaVersion: DASHBOARD_WIDGET_SCHEMA_VERSION,
      sourceId: SOURCE_ID,
      presentation: { title: 'Requests by region' },
      binding: { category: 'region', value: 'successful' },
    },
    {
      kind: 'gauge' as const,
      schemaVersion: DASHBOARD_WIDGET_SCHEMA_VERSION,
      sourceId: SOURCE_ID,
      presentation: { title: 'Daily target' },
      binding: { value: 'successful', target: 'failed' },
    },
    {
      kind: 'scatter' as const,
      schemaVersion: DASHBOARD_WIDGET_SCHEMA_VERSION,
      sourceId: SOURCE_ID,
      presentation: { title: 'Succeeded versus failed' },
      binding: { x: 'successful', y: 'failed', label: 'region' },
    },
  ]

  for (const definition of definitions) {
    const parsed = WidgetDefinitionSchema.parse(definition)
    assert.deepEqual(validateWidgetBinding(parsed, columns), [])
  }
})

test('additional chart bindings refuse fields their renderers cannot plot', () => {
  const gauge = WidgetDefinitionSchema.parse({
    kind: 'gauge',
    schemaVersion: DASHBOARD_WIDGET_SCHEMA_VERSION,
    sourceId: SOURCE_ID,
    presentation: { title: 'Daily target' },
    binding: { value: 'successful', target: 'region' },
  })
  const scatter = WidgetDefinitionSchema.parse({
    kind: 'scatter',
    schemaVersion: DASHBOARD_WIDGET_SCHEMA_VERSION,
    sourceId: SOURCE_ID,
    presentation: { title: 'Correlation' },
    binding: { x: 'region', y: 'failed' },
  })

  assert.match(validateWidgetBinding(gauge, columns)[0]?.message ?? '', /is string/)
  assert.match(validateWidgetBinding(scatter, columns)[0]?.message ?? '', /is string/)
})

test('binding validation refuses a field the source does not declare', () => {
  const parsed = WidgetDefinitionSchema.parse({
    ...timeseries,
    binding: { x: 'observed_at', series: [{ key: 'not_a_column', label: 'Nope' }] },
  })
  const [issue, ...rest] = validateWidgetBinding(parsed, columns)
  assert.equal(rest.length, 0)
  assert.match(issue?.message ?? '', /no column named "not_a_column"/)
})

test('binding validation refuses plotting a string column as a series', () => {
  const parsed = WidgetDefinitionSchema.parse({
    ...timeseries,
    binding: { x: 'observed_at', series: [{ key: 'region', label: 'Region' }] },
  })
  const [issue, ...rest] = validateWidgetBinding(parsed, columns)
  assert.equal(rest.length, 0)
  assert.match(issue?.message ?? '', /is string; this slot accepts number/)
})

test('binding validation reports every problem at once, not just the first', () => {
  const parsed = WidgetDefinitionSchema.parse({
    ...timeseries,
    binding: {
      x: 'missing_time',
      series: [
        { key: 'region', label: 'Region' },
        { key: 'also_missing', label: 'Gone' },
      ],
    },
  })
  assert.equal(validateWidgetBinding(parsed, columns).length, 3)
})

test('a table cannot sort by a column it does not display', () => {
  const parsed = WidgetDefinitionSchema.parse({
    kind: 'table',
    schemaVersion: DASHBOARD_WIDGET_SCHEMA_VERSION,
    sourceId: SOURCE_ID,
    presentation: { title: 'Regions' },
    binding: {
      columns: [{ key: 'region', label: 'Region' }],
      sort: { key: 'failed', direction: 'desc' },
    },
  })
  const [issue, ...rest] = validateWidgetBinding(parsed, columns)
  assert.equal(rest.length, 0)
  assert.match(issue?.message ?? '', /does not display it/)
})

test('a valid binding produces no issues', () => {
  const parsed = WidgetDefinitionSchema.parse(timeseries)
  assert.deepEqual(validateWidgetBinding(parsed, columns), [])
})
