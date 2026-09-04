import assert from 'node:assert/strict'
import test from 'node:test'

import { type ApiClient, ApiClientProvider } from '@nessie/client-core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  canCreateStandingConsentFromApproval,
  RunApprovalGate,
} from '../src/components/features/channels/RunApprovalGate.js'
import { approvalKeys } from '../src/lib/query-keys.js'
import { ToastProvider } from '../src/providers/ToastProvider.js'

const CONNECTION = '00000000-0000-4000-8000-000000000001'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

test('only supported Google approvals offer standing consent', () => {
  const context = { approvedGoogleConnectionId: CONNECTION }
  assert.equal(canCreateStandingConsentFromApproval('gmail_draft_send', context), true)
  assert.equal(canCreateStandingConsentFromApproval('calendar_event_create', context), true)
  assert.equal(canCreateStandingConsentFromApproval('mailbox_send', context), false)
  assert.equal(canCreateStandingConsentFromApproval('email_account_disconnect', context), false)
})

test('a supported tool without a frozen connection cannot offer standing consent', () => {
  assert.equal(canCreateStandingConsentFromApproval('calendar_event_cancel', {}), false)
})

const renderApproval = (toolName: string): string => {
  const queryClient = new QueryClient()
  queryClient.setQueryData(approvalKeys.detail('approval-1'), {
    context: {},
    status: 'pending',
  })
  const unavailable = async () => { throw new Error('unexpected API call') }
  const apiClient = {
    delete: unavailable,
    get: unavailable,
    getPage: unavailable,
    patch: unavailable,
    post: unavailable,
    put: unavailable,
  } as ApiClient
  return renderToStaticMarkup(createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(
      ApiClientProvider,
      { client: apiClient },
      createElement(
        ToastProvider,
        null,
        createElement(RunApprovalGate, {
          metadata: { approvalGate: { approvalId: 'approval-1', status: 'pending', toolName } },
        }),
      ),
    ),
  ))
}

test('mailbox send and account disconnect retain one-time approval controls only', () => {
  for (const toolName of ['mailbox_send', 'email_account_disconnect']) {
    const html = renderApproval(toolName)
    assert.match(html, /Approve action/)
    assert.match(html, /Reject/)
    assert.doesNotMatch(html, /Approve, and don’t ask again/)
  }
})
