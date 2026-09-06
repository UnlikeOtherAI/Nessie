import assert from 'node:assert/strict'
import test from 'node:test'

import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { CredentialFormFields } from '../src/pages/project/settings/CredentialFormFields.js'
import type { CredentialForm } from '../src/facades/board-sources/hooks.js'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const linearForm: CredentialForm = {
  createUrl: 'https://linear.app/settings/account/security',
  createLabel: 'Linear → Settings → Security & access',
  fields: [
    {
      key: 'apiKey',
      label: 'Personal API key',
      kind: 'secret',
      placeholder: 'lin_api_…',
      help: 'Give it Read, or Read and Write to move issues from here.',
    },
  ],
}

const render = (form: CredentialForm, values: Record<string, string> = {}): string =>
  renderToStaticMarkup(
    createElement(CredentialFormFields, { form, onChange: () => undefined, values }),
  )

test('the form is drawn from the adapter declaration, not written per provider', () => {
  const html = render(linearForm)
  assert.ok(html.includes('Personal API key'))
  assert.ok(html.includes('lin_api_…'))
  assert.ok(html.includes('Give it Read'))
  // The link says where to make one, in words rather than as a bare URL.
  assert.ok(html.includes('Linear → Settings → Security &amp; access'))
  assert.ok(html.includes('https://linear.app/settings/account/security'))
})

test('a secret field is a password input, so a key is not legible on a shared screen', () => {
  assert.ok(render(linearForm).includes('type="password"'))
})

test('every declared field kind renders its own input type', () => {
  const html = render({
    createUrl: 'https://example.test/tokens',
    createLabel: 'Somewhere',
    fields: [
      { key: 'site', label: 'Site', kind: 'url' },
      { key: 'email', label: 'Email', kind: 'email' },
      { key: 'token', label: 'Token', kind: 'secret' },
      { key: 'note', label: 'Note', kind: 'text' },
    ],
  })
  for (const type of ['url', 'email', 'password', 'text']) {
    assert.ok(html.includes(`type="${type}"`), `expected a ${type} input`)
  }
})

test('a value already typed is shown back, so the form is controlled', () => {
  assert.ok(render(linearForm, { apiKey: 'lin_api_abc' }).includes('value="lin_api_abc"'))
})
