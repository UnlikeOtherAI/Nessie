import assert from 'node:assert/strict'
import test from 'node:test'

import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  ariaFor,
  fieldErrorAria,
  fieldErrorId,
  fieldErrorProps,
  renderFieldError,
} from '../src/components/shared/FormFieldError.js'

// The production Vite transform injects the JSX runtime. Node's lightweight
// tsx loader uses the classic transform for imported TSX modules.
;(globalThis as typeof globalThis & { React: typeof React }).React = React

// The id is what makes the three parts one announcement: the control points at
// it, the region carries it. A drift here breaks the pairing silently — the
// markup still renders, the reader just never reaches the message.
test('one id scheme spans the control and the message region', () => {
  assert.equal(fieldErrorId('channel-name'), 'channel-name-error')
  assert.equal(
    fieldErrorAria('channel-name', 'Taken')['aria-describedby'],
    fieldErrorId('channel-name'),
  )
  assert.equal(fieldErrorProps('channel-name').id, fieldErrorId('channel-name'))
})

test('a control with no error is neither invalid nor described by a missing node', () => {
  assert.deepEqual(fieldErrorAria('url', null), {
    'aria-invalid': false,
    'aria-describedby': undefined,
  })
  assert.deepEqual(fieldErrorAria('url', undefined), {
    'aria-invalid': false,
    'aria-describedby': undefined,
  })
  // The wizard's record form is the same call with the message looked up.
  assert.deepEqual(ariaFor('url', {}), fieldErrorAria('url', undefined))
})

test('a control with an error is marked invalid and points at the message', () => {
  assert.deepEqual(fieldErrorAria('url', 'Enter a URL'), {
    'aria-invalid': true,
    'aria-describedby': 'url-error',
  })
  assert.deepEqual(ariaFor('url', { url: 'Enter a URL' }), {
    'aria-invalid': true,
    'aria-describedby': 'url-error',
  })
})

// `role="alert"` interrupts the reader. It is on the region unconditionally
// because the region only exists once there is something to announce.
test('the message region always announces itself', () => {
  assert.equal(fieldErrorProps('name').role, 'alert')
  assert.match(String(renderToStaticMarkup(renderFieldError('name', 'Required'))), /role="alert"/)
})

test('no message means no region, so nothing is announced', () => {
  assert.equal(renderFieldError('name', undefined), null)
})

// The wizard shipped this treatment and has call sites that key off the test
// id, so the boxed markup and the passthrough are contract, not decoration.
test('the boxed treatment keeps the wizard markup and its data-testid passthrough', () => {
  const markup = String(renderToStaticMarkup(renderFieldError('name', 'Required', 'wizard-name-error')))
  assert.match(markup, /^<div /)
  assert.match(markup, /data-testid="wizard-name-error"/)
  assert.match(markup, /id="name-error"/)
  assert.match(
    markup,
    /rounded-md border border-\[var\(--danger-border\)\] bg-\[var\(--danger-soft\)\]/,
  )
  assert.match(markup, /px-2 py-1 text-xs text-\[var\(--danger-text\)\]/)
  assert.match(markup, /Required/)
})

test('a site that keeps its own markup gets the contract without the box', () => {
  const props = fieldErrorProps('channel-name')
  assert.deepEqual(Object.keys(props).sort(), ['data-testid', 'id', 'role'])
  assert.equal(props['data-testid'], undefined)
})
