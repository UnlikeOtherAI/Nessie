import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AGENT_TODO_MAX_STEPS,
  AGENT_TODO_STEP_TITLE_MAX,
  AgentTodoTemplateStepsSchema,
  assignStepKeys,
} from '../index.js'

const step = (key: string) => ({
  key,
  title: 'Check deployment',
  instructions: 'Confirm the deployment completed successfully.',
})

test('AgentTodoTemplateStepsSchema rejects duplicate step keys', () => {
  const parsed = AgentTodoTemplateStepsSchema.safeParse([step('deployment'), step('deployment')])

  assert.equal(parsed.success, false)
})

test('AgentTodoTemplateStepsSchema rejects an over-long step title', () => {
  const parsed = AgentTodoTemplateStepsSchema.safeParse([
    {
      ...step('deployment'),
      title: 'x'.repeat(AGENT_TODO_STEP_TITLE_MAX + 1),
    },
  ])

  assert.equal(parsed.success, false)
})

test('AgentTodoTemplateStepsSchema rejects zero steps', () => {
  assert.equal(AgentTodoTemplateStepsSchema.safeParse([]).success, false)
})

test('AgentTodoTemplateStepsSchema rejects more than the maximum number of steps', () => {
  const parsed = AgentTodoTemplateStepsSchema.safeParse(
    Array.from({ length: AGENT_TODO_MAX_STEPS + 1 }, (_, index) => step(`step-${index}`)),
  )

  assert.equal(parsed.success, false)
})

test('assignStepKeys is deterministic and creates unique valid keys for colliding titles', () => {
  const input = [
    {
      title: 'Weekly status report',
      instructions: 'Summarize the work completed this week.',
    },
    {
      title: 'Weekly status report',
      instructions: 'List unresolved decisions.',
    },
    {
      title: '日本語の手順',
      instructions: 'Document the localized process.',
    },
    {
      title: '日本語の手順',
      instructions: 'Confirm the localized process is complete.',
    },
  ]

  const assigned = assignStepKeys(input)

  assert.deepEqual(assignStepKeys(input), assigned)
  assert.deepEqual(
    assigned.map((item) => item.key),
    ['weekly-status-report', 'weekly-status-report-2', 'step', 'step-2'],
  )
  assert.equal(new Set(assigned.map((item) => item.key)).size, assigned.length)
  assert.equal(AgentTodoTemplateStepsSchema.safeParse(assigned).success, true)
})

test('assignStepKeys preserves supplied keys and avoids them for generated keys', () => {
  const assigned = assignStepKeys([
    {
      key: 'weekly-status-report',
      title: 'A durable key',
      instructions: 'Keep the assigned key unchanged.',
    },
    {
      title: 'Weekly status report',
      instructions: 'Generate a distinct key beside the reserved key.',
    },
  ])

  assert.deepEqual(
    assigned.map((item) => item.key),
    ['weekly-status-report', 'weekly-status-report-2'],
  )
})
