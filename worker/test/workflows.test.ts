import assert from 'node:assert/strict'
import test from 'node:test'

import {
  computeWorkflowStepFinishTransition,
  mergeStepRunOutput,
} from '../src/run/workflows.js'

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
