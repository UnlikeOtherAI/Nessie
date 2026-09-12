import assert from 'node:assert/strict'
import test from 'node:test'

import { ApiClientProvider, type ApiClient } from '@nessie/client-core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { WorkflowRunDetail } from '../src/components/features/workflows/WorkflowRunDetail.js'
import { workflowKeys } from '../src/facades/workflows/keys.js'
import type { WorkflowRunDetail as WorkflowRunDetailRecord } from '../src/lib/api-client.js'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const runId = '00000000-0000-4000-8000-000000000010'
const timestamp = '2026-09-12T10:00:00.000Z'
const unavailable = async () => { throw new Error('unexpected API call') }
const apiClient = {
  delete: unavailable,
  get: unavailable,
  patch: unavailable,
  post: unavailable,
  put: unavailable,
} as ApiClient

const detail = (status: 'completed' | 'running'): WorkflowRunDetailRecord => ({
  run: {
    createdAt: timestamp,
    id: runId,
    input: {},
    installationId: '00000000-0000-4000-8000-000000000011',
    organizationId: '00000000-0000-4000-8000-000000000012',
    output: {},
    startedByActorId: '00000000-0000-4000-8000-000000000013',
    startedByActorType: 'user',
    status,
    updatedAt: timestamp,
  },
  steps: status === 'running'
    ? [{
      createdAt: timestamp,
      id: '00000000-0000-4000-8000-000000000014',
      input: {},
      output: {},
      sequence: 0,
      status: 'pending',
      stepKey: 'notify',
      stepType: 'tool',
      title: 'Notify',
      updatedAt: timestamp,
      workflowRunId: runId,
    }]
    : [],
})

const renderRun = (isWorkflowAdmin: boolean, status: 'completed' | 'running') => {
  const queryClient = new QueryClient()
  queryClient.setQueryData(workflowKeys.run(runId), detail(status))
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        ApiClientProvider,
        { client: apiClient },
        createElement(WorkflowRunDetail, { isWorkflowAdmin, workflowRunId: runId }),
      ),
    ),
  )
}

test('workflow readers can inspect a run without receiving mutation controls', () => {
  const active = renderRun(false, 'running')
  const terminal = renderRun(false, 'completed')

  assert.doesNotMatch(active, />Cancel</)
  assert.doesNotMatch(active, />Skip</)
  assert.doesNotMatch(active, />Block</)
  assert.doesNotMatch(terminal, />Retry</)
})

test('workflow administrators receive the applicable run and step controls', () => {
  const active = renderRun(true, 'running')
  const terminal = renderRun(true, 'completed')

  assert.match(active, />Cancel</)
  assert.match(active, />Skip</)
  assert.match(active, />Block</)
  assert.match(terminal, />Retry</)
})
