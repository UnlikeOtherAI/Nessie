import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canBlockWorkflowStepRun,
  canRetryWorkflowRun,
  canSkipWorkflowStepRun,
  canUnblockWorkflowStepRun,
  isActiveWorkflowRunStatus,
  isTerminalWorkflowRunStatus,
} from '../src/services/workflow-runs.js'

test('isTerminalWorkflowRunStatus flags only cancelled/completed/failed', () => {
  assert.equal(isTerminalWorkflowRunStatus('cancelled'), true)
  assert.equal(isTerminalWorkflowRunStatus('completed'), true)
  assert.equal(isTerminalWorkflowRunStatus('failed'), true)
  assert.equal(isTerminalWorkflowRunStatus('pending'), false)
  assert.equal(isTerminalWorkflowRunStatus('running'), false)
})

test('isActiveWorkflowRunStatus flags pending and running', () => {
  assert.equal(isActiveWorkflowRunStatus('pending'), true)
  assert.equal(isActiveWorkflowRunStatus('running'), true)
  assert.equal(isActiveWorkflowRunStatus('completed'), false)
  assert.equal(isActiveWorkflowRunStatus('failed'), false)
  assert.equal(isActiveWorkflowRunStatus('cancelled'), false)
})

test('canRetryWorkflowRun allows only terminal runs', () => {
  assert.equal(canRetryWorkflowRun('failed'), true)
  assert.equal(canRetryWorkflowRun('cancelled'), true)
  assert.equal(canRetryWorkflowRun('completed'), true)
  assert.equal(canRetryWorkflowRun('pending'), false)
  assert.equal(canRetryWorkflowRun('running'), false)
})

test('canSkipWorkflowStepRun allows pending or blocked steps on active runs', () => {
  assert.equal(
    canSkipWorkflowStepRun({ runStatus: 'running', stepStatus: 'pending' }),
    true,
  )
  assert.equal(
    canSkipWorkflowStepRun({ runStatus: 'pending', stepStatus: 'blocked' }),
    true,
  )
  assert.equal(
    canSkipWorkflowStepRun({ runStatus: 'running', stepStatus: 'running' }),
    false,
  )
  assert.equal(
    canSkipWorkflowStepRun({ runStatus: 'running', stepStatus: 'completed' }),
    false,
  )
  assert.equal(
    canSkipWorkflowStepRun({ runStatus: 'completed', stepStatus: 'pending' }),
    false,
  )
})

test('canBlockWorkflowStepRun only allows pending steps on active runs', () => {
  assert.equal(
    canBlockWorkflowStepRun({ runStatus: 'running', stepStatus: 'pending' }),
    true,
  )
  assert.equal(
    canBlockWorkflowStepRun({ runStatus: 'pending', stepStatus: 'pending' }),
    true,
  )
  assert.equal(
    canBlockWorkflowStepRun({ runStatus: 'running', stepStatus: 'running' }),
    false,
  )
  assert.equal(
    canBlockWorkflowStepRun({ runStatus: 'running', stepStatus: 'blocked' }),
    false,
  )
  assert.equal(
    canBlockWorkflowStepRun({ runStatus: 'failed', stepStatus: 'pending' }),
    false,
  )
})

test('canUnblockWorkflowStepRun only allows blocked steps on active runs', () => {
  assert.equal(
    canUnblockWorkflowStepRun({ runStatus: 'running', stepStatus: 'blocked' }),
    true,
  )
  assert.equal(
    canUnblockWorkflowStepRun({ runStatus: 'pending', stepStatus: 'blocked' }),
    true,
  )
  assert.equal(
    canUnblockWorkflowStepRun({ runStatus: 'running', stepStatus: 'pending' }),
    false,
  )
  assert.equal(
    canUnblockWorkflowStepRun({ runStatus: 'running', stepStatus: 'running' }),
    false,
  )
  assert.equal(
    canUnblockWorkflowStepRun({ runStatus: 'cancelled', stepStatus: 'blocked' }),
    false,
  )
})
