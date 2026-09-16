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
import { ExecutorPermittedPrograms } from '../src/components/features/executors/ExecutorPermittedPrograms.js'
import { ExecutorReviewedPolicy } from '../src/components/features/executors/ExecutorReviewedPolicy.js'

/**
 * Nobody may approve `command.run` without reading the programs they are
 * approving. The list travels on the signed descriptor, so the screen that
 * offers "Review activation" has to state it next to that control.
 *
 * The state this pins hardest is the absent one. A descriptor that names no
 * program permits none — it is not an unrestricted executor — and a card that
 * simply omitted the line would read exactly like a card whose list happened
 * to be short.
 */

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
      { initialEntries: ['/agents/executors'] },
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(
          ApiClientProvider,
          { client: apiClient },
          createElement(ExecutorDetailPanels, {
            access: accessView,
            agents: [],
            executor,
            onPrepared: () => undefined,
            reviews: [],
            users: [],
          }),
        ),
      ),
    ),
  )

test('the policy proposal names the programs beside its review control', () => {
  const html = renderPanels(access(['git', 'node', 'rg']))
  assert.match(html, /Permitted programs \(3\)/)
  assert.match(html, /git, node, rg/)
  assert.match(html, /Review activation/)
})

test('a proposal that names no program says so rather than leaving a gap', () => {
  const html = renderPanels(access())
  assert.match(html, /Permitted programs: none named/)
  assert.match(html, /can run nothing until its local policy names one/)
  // An absent list must never be dressed up as a list, empty or otherwise.
  assert.doesNotMatch(html, /Permitted programs \(0\)/)
  assert.match(html, /Review activation/)
})

test('the two states do not render alike', () => {
  assert.notEqual(renderPanels(access(['git'])), renderPanels(access()))
})

// A proposal that enables no command execution has no approval decision the
// list would inform, so the line stays off rather than asserting a boundary
// that is not on offer.
test('a proposal without command.run carries no permitted-program line', () => {
  const html = renderPanels(access(undefined, ['file.read', 'workspace.review']))
  assert.doesNotMatch(html, /Permitted programs/)
})

test('a list without command.run is still shown, and says it is not enabled', () => {
  const html = renderToStaticMarkup(
    createElement(ExecutorPermittedPrograms, {
      commandAllowlist: ['git'],
      operationKeys: ['file.read'],
    }),
  )
  assert.match(html, /Permitted programs \(1\)/)
  assert.match(html, /does not enable command.run/)
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
  assert.match(html, /Revision 4 local policy/)
  assert.match(html, /command.run, workspace.review, sandbox.stop/)
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
