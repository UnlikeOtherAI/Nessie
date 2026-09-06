import assert from 'node:assert/strict'
import test from 'node:test'

import { BUILTIN_TOOL_DEFINITIONS } from '@nessie/runtime'

import { coerceJsonEncodedToolArguments } from '../src/run/tool-argument-coercion.js'

/**
 * The Dashboard Designer, reporting its own blocker in production:
 *
 *   Every dashboard_widget_add call returns "Expected object, received string"
 *   for the widget definition, same as the source probe/create tools do for
 *   array params. String-only tools like import and create work,
 *   object/array-param tools don't.
 *
 * The model serializes a parameter it has no declared structure for, the outer
 * arguments JSON parses fine, and the inner value reaches zod as a string.
 */

const definition = {
  binding: { value: 'rate' },
  kind: 'stat',
  presentation: { title: 'EUR per USD', tone: 'accent' },
  schemaVersion: 1,
  sourceId: '00000000-0000-4000-8000-000000000001',
}

test('a stringified object parameter is restored', () => {
  const corrected = coerceJsonEncodedToolArguments('dashboard_widget_add', {
    dashboardId: 'dash-1',
    definition: JSON.stringify(definition),
  })

  assert.deepEqual(corrected.definition, definition)
  // Untouched, so an id never becomes something else on the way through.
  assert.equal(corrected.dashboardId, 'dash-1')
})

test('a stringified array parameter is restored, and so are stringified members', () => {
  const columns = [
    { key: 'currency', label: 'Currency', nullable: false, type: 'string' },
    { key: 'rate', label: 'Rate', nullable: false, type: 'number' },
  ]

  assert.deepEqual(
    coerceJsonEncodedToolArguments('dashboard_source_create', {
      name: 'USD rates',
      outputColumns: JSON.stringify(columns),
    }).outputColumns,
    columns,
  )

  // The same fault one level down: a real array of serialized records.
  assert.deepEqual(
    coerceJsonEncodedToolArguments('dashboard_source_create', {
      name: 'USD rates',
      outputColumns: columns.map((column) => JSON.stringify(column)),
    }).outputColumns,
    columns,
  )
})

test('a declared string is never parsed, even when it looks like JSON', () => {
  // dashboard_source_import carries real JSON *as a string* — that is its whole
  // purpose. Coercing it would destroy the payload it exists to carry.
  const content = JSON.stringify([{ a: 1 }])
  const corrected = coerceJsonEncodedToolArguments('dashboard_source_import', {
    content,
    format: 'json',
    name: 'Imported',
  })

  assert.equal(corrected.content, content)
  assert.equal(typeof corrected.content, 'string')
})

test('a value that does not parse, or parses to the wrong kind, is left alone', () => {
  // Left as it arrived so the tool's own validation still reports the fault.
  for (const value of ['{not json', '"a string"', '42', '{}extra']) {
    assert.equal(
      coerceJsonEncodedToolArguments('dashboard_widget_add', {
        dashboardId: 'dash-1',
        definition: value,
      }).definition,
      value,
    )
  }

  // An array-declared parameter handed an object must not silently become one.
  assert.equal(
    coerceJsonEncodedToolArguments('dashboard_source_create', {
      name: 'x',
      outputColumns: '{"key":"currency"}',
    }).outputColumns,
    '{"key":"currency"}',
  )
})

test('arguments already correct are returned unchanged, by identity', () => {
  const args = { dashboardId: 'dash-1', definition }
  assert.equal(coerceJsonEncodedToolArguments('dashboard_widget_add', args), args)
  // An unknown tool has no declared schema to consult.
  assert.equal(coerceJsonEncodedToolArguments('not_a_builtin', args), args)
})

test('every builtin parameter with no declared structure is covered by this rule', () => {
  // The parameters a model has to guess at — `type: object` with no properties,
  // or `items: { type: object }`. This is the population the correction serves;
  // the assertion exists so a new one cannot be added without it being seen.
  const bare: string[] = []
  const walk = (node: unknown, path: string, toolId: string): void => {
    if (!node || typeof node !== 'object') return
    const schema = node as { type?: unknown; properties?: unknown; items?: unknown }
    if (schema.type === 'object' && !schema.properties) bare.push(`${toolId}.${path}`)
    if (schema.properties && typeof schema.properties === 'object') {
      for (const [key, child] of Object.entries(schema.properties)) {
        walk(child, `${path}.${key}`, toolId)
      }
    }
    if (schema.items) walk(schema.items, `${path}[]`, toolId)
  }
  for (const tool of BUILTIN_TOOL_DEFINITIONS) walk(tool.parameters, 'parameters', tool.id)

  assert.ok(bare.length > 0, 'expected the structureless parameters this exists for')
  // The ones the Dashboard Designer could not call.
  for (const expected of [
    'dashboard_widget_add.parameters.definition',
    'dashboard_widget_move.parameters.rects[]',
    'dashboard_source_create.parameters.outputColumns[]',
    'dashboard_presentation_update.parameters.presentation',
  ]) {
    assert.ok(bare.includes(expected), `${expected} is no longer structureless`)
  }
})
