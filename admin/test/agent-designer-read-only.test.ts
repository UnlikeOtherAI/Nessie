import assert from 'node:assert/strict'
import test from 'node:test'

import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import {
  AgentInstructionsField,
  AgentMannerFields,
  AgentModelFields,
  AgentNameRoleFields,
  AgentTodosSetting,
  AgentVisibilityField,
} from '../src/components/features/agents/page/AgentConfigFields.js'
import { fakeAgentConfigForm } from './support/agent-config-form.js'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

/**
 * Every field group the agent page's Instructions and Settings tabs render,
 * in the order the tabs render them — the whole configuration a reader sees.
 */
const renderFields = (readOnly: boolean): Document => {
  const form = fakeAgentConfigForm({ state: { name: 'Agent Designer' } })
  const html = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(
        MemoryRouter,
        null,
        createElement(AgentInstructionsField, { form, readOnly }),
        createElement(AgentMannerFields, { form, readOnly }),
        createElement(AgentNameRoleFields, { form, readOnly }),
        createElement(AgentVisibilityField, { form, readOnly }),
        createElement(AgentModelFields, { form, readOnly }),
        createElement(AgentTodosSetting, { canManageTodos: true, form, readOnly }),
      ),
    ),
  )
  return new JSDOM(`<body>${html}</body>`).window.document
}

/**
 * A built-in agent, or one this reader does not manage, renders the ordinary
 * fields with every control inert. The assertion deliberately enumerates
 * NOTHING: it walks whatever rendered and demands each control be disabled,
 * because the way this breaks is a *new* field landing without the prop, not a
 * known one losing it — the voice and manner fields did exactly that once and
 * stayed live on a built-in agent's page until a browser pass caught them.
 *
 * `:disabled` rather than the `disabled` property, so a control inheriting the
 * state from an ancestor `<fieldset disabled>` counts — that inheritance is the
 * mechanism this relies on, and reading the property would report it enabled.
 */
test('every control in the read-only agent fields is inert', () => {
  const document = renderFields(true)
  const controls = [...document.querySelectorAll('input, textarea, select')]

  assert.ok(controls.length > 0, 'the fields should still render')
  const live = controls.filter((control) => !control.matches(':disabled'))
  assert.deepEqual(
    live.map((control) => control.getAttribute('id') ?? control.tagName.toLowerCase()),
    [],
    'a read-only agent must expose no editable control',
  )
})

test('the same fields are editable when they are not read-only', () => {
  const document = renderFields(false)
  const live = [...document.querySelectorAll('input, textarea, select')]
    .filter((control) => !control.matches(':disabled'))

  assert.ok(live.length > 0, 'the ordinary fields must stay editable — otherwise the test above proves nothing')
})

test('the fields offer nothing to save on their own', () => {
  const document = renderFields(true)
  const saveButtons = [...document.querySelectorAll('button')].filter((button) =>
    /save/i.test(button.textContent ?? ''),
  )

  // Saving is the page's one save bar, shown only to someone who manages it.
  assert.deepEqual(saveButtons, [], 'a disabled Save would promise it becomes saveable')
})
