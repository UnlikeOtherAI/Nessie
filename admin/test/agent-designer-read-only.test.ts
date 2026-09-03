import assert from 'node:assert/strict'
import test from 'node:test'

import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'

import { AgentDesignerForm } from '../src/components/features/agents/designer/AgentDesignerForm.js'
import { emptyRunLimitsForm } from '../src/components/features/agents/designer/run-limits.js'
import type {
  AgentDesignerActions,
  AgentFormState,
} from '../src/components/features/agents/designer/useAgentDesigner.js'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const actions: AgentDesignerActions = {
  applyToolCall: () => undefined,
  dispatch: () => undefined,
  setEffort: () => undefined,
  setModelSelection: () => undefined,
  setName: () => undefined,
  setRole: () => undefined,
  setRunLimit: () => undefined,
  setSpeakingStyle: () => undefined,
  setSystemPrompt: () => undefined,
  setTodosEnabled: () => undefined,
  setVoiceName: () => undefined,
  toggleTool: () => undefined,
}

const state: AgentFormState = {
  effort: 'medium',
  model: '',
  name: 'Agent Designer',
  provider: '',
  role: 'agent designer',
  runLimits: emptyRunLimitsForm,
  speakingStyle: '',
  streamingField: null,
  systemPrompt: 'You are the Agent Designer.',
  todosEnabled: false,
  tools: {},
  voiceName: '',
}

const renderForm = (readOnly: boolean): Document => {
  const html = renderToStaticMarkup(
    createElement(AgentDesignerForm, {
      actions,
      canManageExplicitTools: true,
      canManageTodos: true,
      modelOptions: [],
      modelsLoading: false,
      readOnly,
      showTools: false,
      state,
      toolGroups: [],
      toolsLoading: false,
    }),
  )
  return new JSDOM(`<body>${html}</body>`).window.document
}

/**
 * A blueprint agent renders the ordinary designer form with every control
 * inert. The assertion deliberately enumerates NOTHING: it walks whatever the
 * form rendered and demands that each control be disabled, because the way this
 * breaks is a *new* section landing without the prop, not a known one losing
 * it. `AgentSpeechFieldset` did exactly that — it shipped after the read-only
 * mode and stayed live on the Agent Designer's page until a browser pass caught
 * two selects and a textarea a viewer could still change.
 *
 * `:disabled` rather than the `disabled` property, so a control inheriting the
 * state from an ancestor `<fieldset disabled>` counts — that inheritance is the
 * mechanism this relies on, and reading the property would report it enabled.
 */
test('every control in the read-only designer form is inert', () => {
  const document = renderForm(true)
  const controls = [...document.querySelectorAll('input, textarea, select')]

  assert.ok(controls.length > 0, 'the form should still render its fields')

  const live = controls.filter((control) => !control.matches(':disabled'))
  assert.deepEqual(
    live.map((control) => control.getAttribute('id') ?? control.tagName.toLowerCase()),
    [],
    'a read-only agent must expose no editable control',
  )
})

test('the same form is editable when it is not read-only', () => {
  const document = renderForm(false)
  const controls = [...document.querySelectorAll('input, textarea, select')]
  const live = controls.filter((control) => !control.matches(':disabled'))

  assert.ok(
    live.length > 0,
    'the ordinary form must stay editable — otherwise the test above proves nothing',
  )
})

test('a read-only form offers nothing to save', () => {
  const document = renderForm(true)
  const saveButtons = [...document.querySelectorAll('button')].filter((button) =>
    /save/i.test(button.textContent ?? ''),
  )

  assert.deepEqual(saveButtons, [], 'a disabled Save would promise it becomes saveable')
})
