import assert from 'node:assert/strict'
import test from 'node:test'

import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AGENT_TODO_MAX_STEPS,
  AGENT_TODO_STEP_INSTRUCTIONS_MAX,
  AGENT_TODO_STEP_TITLE_MAX,
  AGENT_TODO_TEMPLATE_DESCRIPTION_MAX,
  AGENT_TODO_TEMPLATE_NAME_MAX,
} from '@nessie/schemas'

import { AgentDesignerForm } from '../src/components/features/agents/designer/AgentDesignerForm.js'
import { TodoTemplateEditor } from '../src/components/features/agents/todos/TodoTemplateEditor.js'
import { emptyRunLimitsForm } from '../src/components/features/agents/designer/run-limits.js'
import type {
  AgentDesignerActions,
  AgentFormState,
} from '../src/components/features/agents/designer/useAgentDesigner.js'
import { agentTodoKeys } from '../src/lib/query-keys.js'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const actions: AgentDesignerActions = {
  applyToolCall: () => undefined,
  dispatch: () => undefined,
  setEffort: () => undefined,
  setModelSelection: () => undefined,
  setName: () => undefined,
  setRole: () => undefined,
  setRunLimit: () => undefined,
  setSystemPrompt: () => undefined,
  setTodosEnabled: () => undefined,
  toggleTool: () => undefined,
}

const state: AgentFormState = {
  effort: 'medium',
  model: '',
  name: 'Checklist agent',
  provider: '',
  role: 'assistant',
  runLimits: emptyRunLimitsForm,
  streamingField: null,
  systemPrompt: '',
  todosEnabled: false,
  tools: {},
}

test('the Designer renders the persisted to-dos switch and visibility caveat', () => {
  const html = renderToStaticMarkup(
    createElement(AgentDesignerForm, {
      actions,
      canManageExplicitTools: true,
      modelOptions: [],
      modelsLoading: false,
      showTools: false,
      state,
      toolGroups: [],
      toolsLoading: false,
    }),
  )

  assert.match(html, /role="switch"/)
  assert.match(html, /aria-label="Enable to-dos for this agent"/)
  assert.match(html, /Give this agent reusable checklists it can work through\./)
  assert.match(html, /Do not put secrets in them\./)
})

test('the template editor takes every persisted bound from the shared schema', () => {
  const html = renderToStaticMarkup(
    createElement(TodoTemplateEditor, {
      onCancel: () => undefined,
      onSave: async () => undefined,
      saving: false,
    }),
  )

  assert.match(html, new RegExp(`1 / ${AGENT_TODO_MAX_STEPS} steps`))
  assert.match(html, new RegExp(`maxLength="${AGENT_TODO_TEMPLATE_NAME_MAX}"`))
  assert.match(html, new RegExp(`maxLength="${AGENT_TODO_TEMPLATE_DESCRIPTION_MAX}"`))
  assert.match(html, new RegExp(`maxLength="${AGENT_TODO_STEP_TITLE_MAX}"`))
  assert.match(html, new RegExp(`maxLength="${AGENT_TODO_STEP_INSTRUCTIONS_MAX}"`))
})

test('to-do cache keys remain nested under the agent family', () => {
  assert.deepEqual(agentTodoKeys.instances('agent-1'), ['agents', 'agent-1', 'todos'])
  assert.deepEqual(
    agentTodoKeys.templates('agent-1', true),
    ['agents', 'agent-1', 'todo-templates', true],
  )
  assert.deepEqual(agentTodoKeys.all, ['agents'])
})
