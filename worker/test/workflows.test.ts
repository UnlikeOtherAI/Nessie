import assert from 'node:assert/strict'
import test from 'node:test'

import {
  computeWorkflowStepFinishTransition,
  mergeStepRunOutput,
} from '../src/run/workflows.js'
import { resolveWorkflowStepInput } from '../src/control/workflows.js'

test('computeWorkflowStepFinishTransition keeps run running when more steps remain', () => {
  const transition = computeWorkflowStepFinishTransition({
    remainingSteps: 2,
    success: true,
  })

  assert.deepEqual(transition, {
    continueWorkflow: true,
    nextRunStatus: 'running',
    nextStepStatus: 'completed',
    workflowRunCompleted: false,
  })
})

test('computeWorkflowStepFinishTransition completes run when last step succeeds', () => {
  const transition = computeWorkflowStepFinishTransition({
    remainingSteps: 0,
    success: true,
  })

  assert.deepEqual(transition, {
    continueWorkflow: false,
    nextRunStatus: 'completed',
    nextStepStatus: 'completed',
    workflowRunCompleted: true,
  })
})

test('computeWorkflowStepFinishTransition fails run as soon as a step fails', () => {
  const transition = computeWorkflowStepFinishTransition({
    remainingSteps: 5,
    success: false,
  })

  assert.deepEqual(transition, {
    continueWorkflow: false,
    nextRunStatus: 'failed',
    nextStepStatus: 'failed',
    workflowRunCompleted: false,
  })
})

test('computeWorkflowStepFinishTransition fails run when last step fails', () => {
  const transition = computeWorkflowStepFinishTransition({
    remainingSteps: 0,
    success: false,
  })

  assert.deepEqual(transition, {
    continueWorkflow: false,
    nextRunStatus: 'failed',
    nextStepStatus: 'failed',
    workflowRunCompleted: false,
  })
})

test('mergeStepRunOutput overlays incoming keys on existing object output', () => {
  const merged = mergeStepRunOutput(
    { foo: 1, bar: 2 },
    { bar: 3, baz: 4 },
  )

  assert.deepEqual(merged, { bar: 3, baz: 4, foo: 1 })
})

test('mergeStepRunOutput replaces non-object existing output', () => {
  assert.deepEqual(mergeStepRunOutput(null, { foo: 1 }), { foo: 1 })
  assert.deepEqual(mergeStepRunOutput([1, 2], { foo: 1 }), { foo: 1 })
  assert.deepEqual(mergeStepRunOutput('string', { foo: 1 }), { foo: 1 })
})

test('mergeStepRunOutput returns empty object when incoming is undefined and existing is not usable', () => {
  assert.deepEqual(mergeStepRunOutput(null, undefined), {})
})

test('mergeStepRunOutput preserves existing object when incoming is undefined', () => {
  assert.deepEqual(mergeStepRunOutput({ foo: 1 }, undefined), { foo: 1 })
})

test('resolveWorkflowStepInput binds workflow input and previous step output references', () => {
  const resolved = resolveWorkflowStepInput(
    {
      details: 'Watch {{workflow.input.url}} with {{workflow.bindings.channelId}}',
      nested: {
        status: '{{steps.fetch.output.status}}',
        summary: '{{steps.fetch.output.summary}}',
      },
      source: '{{workflow.input}}',
    },
    {
      stepSnapshots: {
        fetch: {
          input: { url: 'https://example.com' },
          output: {
            status: 'changed',
            summary: 'Example summary',
          },
          status: 'completed',
        },
      },
      workflowBindings: {
        channelId: 'channel-1',
      },
      workflowConfig: {
        region: 'eu',
      },
      workflowInput: {
        url: 'https://example.com',
      },
    },
  )

  assert.deepEqual(resolved, {
    details: 'Watch https://example.com with channel-1',
    nested: {
      status: 'changed',
      summary: 'Example summary',
    },
    source: {
      url: 'https://example.com',
    },
  })
})

test('resolveWorkflowStepInput throws when a binding cannot be resolved', () => {
  assert.throws(
    () =>
      resolveWorkflowStepInput('{{steps.missing.output}}', {
        stepSnapshots: {},
        workflowBindings: {},
        workflowConfig: {},
        workflowInput: {},
      }),
    /WORKFLOW_BINDING_NOT_FOUND:steps\.missing\.output/,
  )
})
