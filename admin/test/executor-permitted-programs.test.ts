import assert from 'node:assert/strict'
import test from 'node:test'

import { ApiClientProvider, type ApiClient } from '@nessie/client-core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type {
  ExecutorAccessViewResponse,
  ExecutorRecordResponse,
} from '@nessie/schemas'

import { ExecutorDetailPanels } from '../src/components/features/executors/ExecutorDetailPanels.js'
import { ExecutorReachableFolders } from '../src/components/features/executors/ExecutorReachableFolders'
import { ExecutorPermittedPrograms } from '../src/components/features/executors/ExecutorPermittedPrograms.js'
import { ExecutorReviewedPolicy } from '../src/components/features/executors/ExecutorReviewedPolicy.js'

/** Capability summaries remain on legacy confirmation cards; the sharing
 * screen never offers a machine-permission review, even for older reports. */

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const executorId = '00000000-0000-4000-8000-0000000000e1'
const timestamp = '2026-09-16T10:00:00.000Z'
const unavailable = async () => { throw new Error('unexpected API call') }
const apiClient = {
  delete: unavailable,
  get: unavailable,
  patch: unavailable,
  post: unavailable,
  put: unavailable,
} as ApiClient

const executor: ExecutorRecordResponse = {
  authorizationRevision: 1,
  createdAt: timestamp,
  id: executorId,
  label: 'Studio Mac',
  profiles: ['workspace_sandbox'],
  scope: { kind: 'organization', organizationId: '00000000-0000-4000-8000-0000000000a1' },
  status: 'online',
  updatedAt: timestamp,
} as ExecutorRecordResponse

const access = (
  commandAllowlist?: string[],
  operationKeys: string[] = ['command.run', 'workspace.review', 'sandbox.stop'],
): ExecutorAccessViewResponse => ({
  canManage: true,
  descriptorRevisions: [{
    ...(commandAllowlist ? { commandAllowlist } : {}),
    localPolicyDigest: `sha256:${'b'.repeat(64)}`,
    operationKeys,
    profiles: ['workspace_sandbox'],
    reviewStatus: 'pending_review',
    revision: 4,
  }],
  effectiveAccess: {
    organizationRole: 'owner',
    privateAssignment: 'none',
    projectRole: null,
  },
  executorId,
} as ExecutorAccessViewResponse)

const renderPanels = (accessView: ExecutorAccessViewResponse): string =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: ['/agents/executors?tab=permissions'] },
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(
          ApiClientProvider,
          { client: apiClient },
          createElement(ExecutorDetailPanels, {
            // The panel takes the query, not the view, so it can say when the
            // access view could not be read instead of rendering the failure
            // as a finding. These cases are all the settled, successful state.
            accessQuery: {
              data: accessView,
              error: null,
              isError: false,
              isLoading: false,
              refetch: () => undefined,
            } as never,
            executor,
            onPrepared: () => undefined,
          }),
        ),
      ),
    ),
  )

test('permissions does not offer capability review for a legacy pending report', () => {
  for (const view of [access(['git', 'node', 'rg']), access(), access(undefined, ['file.read'])]) {
    const html = renderPanels(view)
    assert.doesNotMatch(html, /Review changes|Review activation|Permitted programs/)
    assert.match(html, /Select a team to manage sharing/)
  }
})

test('a list without command.run is still shown, and says it is not enabled', () => {
  const html = renderToStaticMarkup(
    createElement(ExecutorPermittedPrograms, {
      commandAllowlist: ['git'],
      operationKeys: ['file.read'],
    }),
  )
  assert.match(html, /Permitted programs \(1\)/)
  assert.match(html, /running programs is not enabled/)
})

const renderReviewed = (
  change: Record<string, unknown>,
  commandAllowlist?: string[],
): string => renderToStaticMarkup(
  createElement(ExecutorReviewedPolicy, {
    change,
    descriptorRevisions: access(commandAllowlist).descriptorRevisions,
  }),
)

// The confirmation card is the last screen before `command.run` turns on, and
// the stored change on it names only a revision number.
test('the prepared descriptor review states what that revision permits', () => {
  const html = renderReviewed(
    { kind: 'descriptor_review', revision: 4, status: 'active' },
    ['git', 'node', 'rg'],
  )
  assert.doesNotMatch(html, /Revision 4|sha256:/)
  assert.match(html, /Run permitted programs.*Review draft changes.*Stop a work session/s)
  assert.match(html, /Permitted programs \(3\).*git, node, rg/s)
})

test('a prepared descriptor review that names no program says so before confirmation', () => {
  const html = renderReviewed({ kind: 'descriptor_review', revision: 4, status: 'active' })
  assert.match(html, /Permitted programs: none named/)
})

test('another kind of prepared change carries no policy block', () => {
  assert.equal(
    renderReviewed({ action: 'revoke', kind: 'lifecycle' }, ['git']),
    '',
  )
})

// Better silent than confidently wrong: the revisions loaded here are another
// executor's, or simply older than the one being confirmed.
test('a revision this page did not load renders nothing rather than a guess', () => {
  assert.equal(
    renderReviewed({ kind: 'descriptor_review', revision: 9, status: 'active' }, ['git']),
    '',
  )
  assert.equal(
    renderToStaticMarkup(
      createElement(ExecutorReviewedPolicy, {
        change: { kind: 'descriptor_review', revision: 4, status: 'active' },
      }),
    ),
    '',
  )
})

test('a reviewer reads the folders a revision reaches, and the three states differ', () => {
  const named = renderToStaticMarkup(
    createElement(ExecutorReachableFolders, {
      operationKeys: ['file.read'],
      workspaceFolders: ['code', 'notes'],
    }),
  )
  const unnamed = renderToStaticMarkup(
    createElement(ExecutorReachableFolders, { operationKeys: ['file.read'] }),
  )
  const guestRefused = renderToStaticMarkup(
    createElement(ExecutorReachableFolders, {
      operationKeys: ['command.run'],
      workspaceFolders: ['code', 'notes'],
    }),
  )

  assert.match(named, /Folders \(2\)/u)
  assert.match(named, /code, notes/u)
  // A descriptor signed before folders had names reaches exactly one folder;
  // rendering nothing would read as "no folders", the opposite of the truth.
  assert.match(unnamed, /one folder; its name was not provided/u)
  assert.notEqual(named, unnamed)
  // Several folders with a guest operation enabled says so, because the guest
  // refuses rather than silently binding one of them.
  assert.match(guestRefused, /requires selecting a single folder/u)
  assert.notEqual(named, guestRefused)
  // Host paths never reach a reviewer: the visible text carries names only, so
  // it holds no path separator once the markup's own tags are removed.
  assert.equal(named.replace(/<[^>]*>/gu, '').includes('/'), false)
})
