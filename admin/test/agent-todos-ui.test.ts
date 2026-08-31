import assert from 'node:assert/strict'
import test from 'node:test'

import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import {
  AGENT_TODO_MAX_STEPS,
  AGENT_TODO_STEP_INSTRUCTIONS_MAX,
  AGENT_TODO_STEP_TITLE_MAX,
  AGENT_TODO_TEMPLATE_DESCRIPTION_MAX,
  AGENT_TODO_TEMPLATE_NAME_MAX,
  type AgentTodoRecord,
  type AgentTodoTemplateRecord,
} from '@nessie/schemas'

import { AgentDesignerForm } from '../src/components/features/agents/designer/AgentDesignerForm.js'
import { TodoInstanceCard, canChangeTodo } from '../src/components/features/agents/todos/TodoInstanceCard.js'
import { TodoTemplateCard } from '../src/components/features/agents/todos/TodoTemplateCard.js'
import { TodoTemplateEditor } from '../src/components/features/agents/todos/TodoTemplateEditor.js'
import { emptyRunLimitsForm } from '../src/components/features/agents/designer/run-limits.js'
import type {
  AgentDesignerActions,
  AgentFormState,
} from '../src/components/features/agents/designer/useAgentDesigner.js'
import { agentTodoKeys } from '../src/lib/query-keys.js'
import type { AgentRecord } from '../src/lib/api-client.js'

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
      canManageTodos: true,
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

test('a member sees the to-dos switch but cannot change it', () => {
  const html = renderToStaticMarkup(
    createElement(AgentDesignerForm, {
      actions,
      canManageExplicitTools: false,
      canManageTodos: false,
      modelOptions: [],
      modelsLoading: false,
      showTools: false,
      state,
      toolGroups: [],
      toolsLoading: false,
    }),
  )

  assert.match(html, /aria-label="Enable to-dos for this agent"[^>]*disabled=""/)
  assert.match(html, /Only organization owners can enable or disable to-dos\./)
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

const organizationId = '00000000-0000-4000-8000-000000000101'
const agentId = '00000000-0000-4000-8000-000000000102'
const templateId = '00000000-0000-4000-8000-000000000103'
const todoId = '00000000-0000-4000-8000-000000000104'
const stepId = '00000000-0000-4000-8000-000000000105'
const creatorId = '00000000-0000-4000-8000-000000000106'
const stewardId = '00000000-0000-4000-8000-000000000107'
const unrelatedUserId = '00000000-0000-4000-8000-000000000108'
const timestamp = '2026-08-31T12:00:00.000Z'

const agent: AgentRecord = {
  channelIds: [],
  createdAt: timestamp,
  id: agentId,
  lastActivityAt: timestamp,
  name: 'Checklist agent',
  ownerUserId: stewardId,
  role: 'assistant',
  status: 'idle',
  todosEnabled: true,
  updatedAt: timestamp,
}

const template: AgentTodoTemplateRecord = {
  agentId,
  authorType: 'user',
  createdAt: timestamp,
  createdByUserId: creatorId,
  description: 'Release work in order.',
  id: templateId,
  name: 'Release checklist',
  organizationId,
  proposedByRunId: null,
  status: 'active',
  steps: [{ instructions: 'Verify the release.', key: 'verify-release', title: 'Verify release' }],
  updatedAt: timestamp,
  version: 1,
}

const todo: AgentTodoRecord = {
  activeRunId: null,
  agentId,
  completedAt: null,
  createdAt: timestamp,
  createdByUserId: creatorId,
  id: todoId,
  organizationId,
  status: 'open',
  steps: [{
    completedAt: null,
    id: stepId,
    instructions: 'Verify the release.',
    key: 'verify-release',
    note: null,
    sequence: 0,
    status: 'pending',
    title: 'Verify release',
    todoId,
    updatedByActorId: null,
    updatedByActorType: null,
  }],
  templateId,
  templateVersion: 1,
  threadId: null,
  title: 'Release checklist',
  triggerId: null,
  updatedAt: timestamp,
}

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:5455/agents',
})
const { createRoot } = await import('react-dom/client')

const domGlobals = {
  document: dom.window.document,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  MouseEvent: dom.window.MouseEvent,
  navigator: dom.window.navigator,
  window: dom.window,
}

const mount = async (element: React.ReactElement) => {
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(domGlobals)) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }

  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  await React.act(async () => {
    root.render(element)
  })

  return {
    button: (label: string): HTMLElement => {
      const button = [...container.querySelectorAll('button')].find(
        (candidate) => candidate.textContent?.trim() === label,
      )
      assert.ok(button, `expected ${label} button to render`)
      return button as HTMLElement
    },
    click: async (button: HTMLElement) => {
      await React.act(async () => {
        button.dispatchEvent(
          new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }),
        )
      })
    },
    unmount: async () => {
      await React.act(async () => {
        root.unmount()
      })
      container.remove()
      for (const [key, descriptor] of previousGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    },
  }
}

test('template cards let owners edit and archive but refuse the same buttons to members', async () => {
  const ownerActions: string[] = []
  const owner = await mount(
    createElement(TodoTemplateCard, {
      isOwner: true,
      onArchive: () => ownerActions.push('archive'),
      onEdit: () => ownerActions.push('edit'),
      onRefuseOwnerAction: () => ownerActions.push('refusal'),
      template,
    }),
  )

  try {
    await owner.click(owner.button('Edit'))
    await owner.click(owner.button('Archive'))
    assert.deepEqual(ownerActions, ['edit', 'archive'])
  } finally {
    await owner.unmount()
  }

  const memberActions: string[] = []
  const member = await mount(
    createElement(TodoTemplateCard, {
      isOwner: false,
      onArchive: () => memberActions.push('archive'),
      onEdit: () => memberActions.push('edit'),
      onRefuseOwnerAction: () => memberActions.push('refusal'),
      template,
    }),
  )

  try {
    await member.click(member.button('Edit'))
    await member.click(member.button('Archive'))
    assert.deepEqual(memberActions, ['refusal', 'refusal'])
  } finally {
    await member.unmount()
  }
})

test('to-do cards render sane step copy and only expose changes to entitled people', () => {
  const renderTodoCard = (currentUserId: string, isOwner: boolean): string =>
    renderToStaticMarkup(
      createElement(TodoInstanceCard, {
        agent,
        currentUserId,
        isOwner,
        onCancel: () => undefined,
        onUpdateStep: () => undefined,
        todo,
      }),
    )

  assert.equal(canChangeTodo(todo, agent, creatorId, false), true)
  assert.equal(canChangeTodo(todo, agent, stewardId, false), true)
  assert.equal(canChangeTodo(todo, agent, unrelatedUserId, true), true)
  assert.equal(canChangeTodo(todo, agent, unrelatedUserId, false), false)

  for (const markup of [
    renderTodoCard(creatorId, false),
    renderTodoCard(stewardId, false),
    renderTodoCard(unrelatedUserId, true),
  ]) {
    assert.match(markup, /Cancel to-do/)
    assert.match(markup, />completed<\/button>/)
  }

  const unrelated = renderTodoCard(unrelatedUserId, false)
  assert.match(unrelated, /This step has not been changed yet\./)
  assert.doesNotMatch(unrelated, /Last changed by not yet changed/)
  assert.doesNotMatch(unrelated, /Cancel to-do/)
  assert.doesNotMatch(unrelated, />completed<\/button>/)
})
