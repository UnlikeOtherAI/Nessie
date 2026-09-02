import assert from 'node:assert/strict'
import test from 'node:test'

import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { Card } from '../src/components/shared/Card.js'
import { ChoiceGroup } from '../src/components/shared/ChoiceGroup.js'
import { DataTable } from '../src/components/shared/DataTable.js'
import { EmptyState } from '../src/components/shared/EmptyState.js'
import { FormError, FormSuccess } from '../src/components/shared/FormActions.js'
import { FormField } from '../src/components/shared/FormField.js'
import { Input } from '../src/components/shared/FormControls.js'
import { KeyValueList } from '../src/components/shared/KeyValueList.js'
import { Row, RowList } from '../src/components/shared/RowList.js'
import { StatTile } from '../src/components/shared/StatTile.js'
import { Notice } from '../src/components/primitives/Notice.js'
import { Pill } from '../src/components/primitives/Pill.js'
import { SectionLabel } from '../src/components/primitives/SectionLabel.js'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const render = (node: React.ReactElement): string => renderToStaticMarkup(node)

test('a Card refuses to contain another Card', () => {
  // The no-nesting rule, enforced where it is written rather than noticed in
  // review. Production keeps rendering; only development throws.
  assert.throws(
    () => render(createElement(Card, {}, createElement(Card, {}, 'inner'))),
    /Card cannot be nested inside another Card/,
  )

  assert.doesNotThrow(() => render(createElement(Card, {}, 'alone')))
})

test('a Card carries its tone as a class, because utilities are inert on it', () => {
  // `.admin-card` is unlayered, so `border-[color:var(--accent)]` on the same
  // element does nothing — three executor panels shipped exactly that and
  // never drew the border they intended.
  const markup = render(createElement(Card, { tone: 'attention' }, 'x'))

  assert.match(markup, /admin-card-attention/)
  assert.doesNotMatch(markup, /border-\[color:var\(--accent\)\]/)
})

test('Card variants are the two densities, not free-form padding', () => {
  assert.match(render(createElement(Card, {}, 'x')), /admin-card p-4/)
  assert.match(render(createElement(Card, { variant: 'row' }, 'x')), /admin-card p-3/)
})

test('a RowList draws its own frame alone and drops it inside a Card', () => {
  const standalone = render(
    createElement(RowList, {}, createElement(Row, { key: 'a', title: 'Alpha' })),
  )
  assert.match(standalone, /rounded-xl border/)
  assert.match(standalone, /divide-y/)

  const nested = render(
    createElement(
      Card,
      {},
      createElement(RowList, {}, createElement(Row, { key: 'a', title: 'Alpha' })),
    ),
  )
  assert.doesNotMatch(nested, /rounded-xl border/, 'a bordered box inside a bordered box')
  assert.match(nested, /divide-y/, 'depth is still expressed, as dividers')
})

test('a Row is only a control when it can actually do something', () => {
  const inert = render(createElement(Row, { title: 'Alpha' }))
  assert.doesNotMatch(inert, /<button/)

  const clickable = render(createElement(Row, { onClick: () => undefined, title: 'Alpha' }))
  assert.match(clickable, /<button/)
})

test('a selected Row is marked for assistive tech, not only in colour', () => {
  const markup = render(
    createElement(Row, { onClick: () => undefined, selected: true, title: 'Alpha' }),
  )

  assert.match(markup, /aria-current="true"/)
  assert.match(markup, /border-\[color:var\(--accent\)\]/)
})

test('a KeyValueList is a real definition list', () => {
  const markup = render(
    createElement(KeyValueList, { items: [{ label: 'Team', value: 'Ops' }] }),
  )

  assert.match(markup, /<dl/)
  assert.match(markup, /<dt/)
  assert.match(markup, /<dd/)
})

test('a KeyValueList drops its frame inside a Card too', () => {
  const nested = render(
    createElement(
      Card,
      {},
      createElement(KeyValueList, { items: [{ label: 'Team', value: 'Ops' }] }),
    ),
  )

  assert.doesNotMatch(nested, /rounded-xl border/)
})

test('a DataTable renders real column headers and a caption', () => {
  const markup = render(
    createElement(DataTable<{ id: string; name: string }>, {
      columns: [
        { header: 'Name', key: 'name', render: (row) => row.name },
        { align: 'right', header: 'Id', key: 'id', render: (row) => row.id },
      ],
      label: 'Agents',
      rowKey: (row) => row.id,
      rows: [{ id: '1', name: 'Alpha' }],
    }),
  )

  assert.match(markup, /<caption class="sr-only">Agents<\/caption>/)
  assert.match(markup, /scope="col"/)
  assert.match(markup, /admin-table/)
  assert.match(markup, /Alpha/)
  // Numbers line up under each other or they cannot be compared.
  assert.match(markup, /text-right tabular-nums/)
})

test('a sorted DataTable column announces its direction', () => {
  const markup = render(
    createElement(DataTable<{ id: string }>, {
      columns: [{ header: 'Id', key: 'id', render: (row) => row.id, sortable: true }],
      label: 'Rows',
      onSortChange: () => undefined,
      rowKey: (row) => row.id,
      rows: [{ id: '1' }],
      sort: { field: 'id', order: 'desc' },
    }),
  )

  assert.match(markup, /aria-sort="descending"/)
})

test('a loading DataTable draws its shape, an empty one says so', () => {
  const columns = [{ header: 'Id', key: 'id', render: (row: { id: string }) => row.id }]

  const loading = render(
    createElement(DataTable<{ id: string }>, {
      columns,
      label: 'Rows',
      loading: true,
      rowKey: (row) => row.id,
      rows: [],
      skeletonRows: 3,
    }),
  )
  assert.equal(loading.match(/animate-pulse/g)?.length, 3)

  const empty = render(
    createElement(DataTable<{ id: string }>, {
      columns,
      empty: createElement(EmptyState, {}, 'No rows yet.'),
      label: 'Rows',
      rowKey: (row) => row.id,
      rows: [],
    }),
  )
  assert.match(empty, /No rows yet\./)
  assert.doesNotMatch(empty, /<table/, 'an empty table is a sentence, not an empty grid')
})

test('a FormField wires the control to its label, error and help', () => {
  const markup = render(
    createElement(
      FormField,
      { error: 'Name is already taken.', help: 'Shown to your team.', label: 'Name' },
      createElement(Input, { value: '', onChange: () => undefined }),
    ),
  )

  const controlId = /<input[^>]*\sid="([^"]+)"/.exec(markup)?.[1]
  assert.ok(controlId, 'the control must carry the generated id')

  assert.match(markup, new RegExp(`for="${controlId}"`), 'the label points at the control')
  assert.match(markup, /aria-invalid="true"/)
  assert.match(markup, new RegExp(`aria-describedby="[^"]*${controlId}-help`))
  assert.match(markup, new RegExp(`aria-describedby="[^"]*${controlId}-error`))
  assert.match(markup, /role="alert"/, 'a submit-time error interrupts the reader')
  assert.match(markup, /Name is already taken\./)
})

test('a FormField without an error leaves the control valid and undescribed', () => {
  const markup = render(
    createElement(
      FormField,
      { label: 'Name' },
      createElement(Input, { value: '', onChange: () => undefined }),
    ),
  )

  assert.doesNotMatch(markup, /aria-invalid/)
  assert.doesNotMatch(markup, /role="alert"/)
})

test('a required field says so visibly, not only by refusing to submit', () => {
  const markup = render(
    createElement(
      FormField,
      { label: 'Name', required: true },
      createElement(Input, { value: '', onChange: () => undefined }),
    ),
  )

  assert.match(markup, /title="Required"/)
})

test('form-level messages carry the right urgency and render nothing when empty', () => {
  assert.match(render(createElement(FormError, {}, 'Could not save.')), /role="alert"/)
  assert.match(render(createElement(FormSuccess, {}, 'Saved.')), /role="status"/)
  assert.equal(render(createElement(FormError, {})), '')
  assert.equal(render(createElement(FormSuccess, {})), '')
})

test('a ChoiceGroup is one keyboard stop with one announced value', () => {
  const markup = render(
    createElement(ChoiceGroup<'a' | 'b'>, {
      label: 'Depth',
      onChange: () => undefined,
      options: [
        { label: 'Quick', value: 'a' },
        { label: 'Deep', value: 'b' },
      ],
      value: 'b',
    }),
  )

  assert.match(markup, /<fieldset/)
  assert.match(markup, /<legend/)
  assert.equal(markup.match(/type="radio"/g)?.length, 2)
  // Both radios share one name, which is what makes them one group.
  const names = [...markup.matchAll(/name="([^"]+)"/g)].map((match) => match[1])
  assert.equal(new Set(names).size, 1)
  assert.equal(markup.match(/checked=""/g)?.length, 1)
})

test('an EmptyState can carry a title and a way out', () => {
  const markup = render(
    createElement(
      EmptyState,
      { action: createElement('button', { type: 'button' }, 'Connect'), title: 'No connections' },
      'Connect an account to get started.',
    ),
  )

  assert.match(markup, /border-dashed/)
  assert.match(markup, /No connections/)
  assert.match(markup, /Connect an account/)
  assert.match(markup, /<button type="button">Connect<\/button>/)
})

test('a StatTile colours the number, never the box', () => {
  const markup = render(
    createElement(StatTile, { detail: 'this month', label: 'Spend', tone: 'danger', value: '£12' }),
  )

  assert.match(markup, /text-\[color:var\(--danger-text\)\]/)
  assert.match(markup, /admin-card/)
  assert.doesNotMatch(markup, /bg-\[color:var\(--danger/)
})

test('the primitive gaps the audit named are closed', () => {
  // Each of these tones or sizes was the stated reason a surface hand-rolled
  // its own copy instead of using the primitive.
  assert.match(render(createElement(Notice, { tone: 'info' }, 'x')), /--info-soft/)
  assert.match(render(createElement(Notice, { tone: 'neutral' }, 'x')), /--overlay-weak/)
  assert.match(render(createElement(Pill, { tone: 'outline' }, 'x')), /border border-\[color:var\(--sep\)\]/)
  assert.doesNotMatch(render(createElement(Pill, { tone: 'outline' }, 'x')), /bg-/)
  assert.match(render(createElement(Pill, { height: 'control' }, 'x')), /h-6/)
  assert.match(render(createElement(SectionLabel, { size: 'sm' }, 'x')), /tracking-\[0\.16em\]/)
})
