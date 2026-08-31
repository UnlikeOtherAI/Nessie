import assert from 'node:assert/strict'
import test from 'node:test'

import { ApiClientProvider, type ApiClient } from '@nessie/client-core'
import { KnowledgeSpaceResponseSchema } from '@nessie/schemas'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { SpaceSettingsDialog } from '../src/components/features/knowledge/SpaceSettingsDialog.js'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const space = KnowledgeSpaceResponseSchema.parse({
  canManageAccess: false,
  canWrite: true,
  createdAt: '2026-08-31T12:00:00.000Z',
  createdBy: '00000000-0000-4000-8000-000000000099',
  deletedAt: null,
  description: 'Shared reference material',
  id: '00000000-0000-4000-8000-000000000004',
  memberAgentIds: [],
  memberUserIds: [],
  metadata: null,
  name: 'Engineering',
  organizationId: '00000000-0000-4000-8000-000000000001',
  ownerAgentId: null,
  policyChainTrace: ['decision:ALLOWED'],
  projectId: '00000000-0000-4000-8000-000000000002',
  sensitivityTier: 'normal',
  sourceRef: 'kb://first-party/spaces/space',
  updatedAt: '2026-08-31T12:00:00.000Z',
  visibility: 'project',
  visibilityReason: 'project visibility',
  writeRestricted: false,
})

test('a plain writer sees ordinary settings but not access administration controls', () => {
  const queryClient = new QueryClient()
  const unavailable = async () => { throw new Error('unexpected API call') }
  const apiClient = {
    delete: unavailable,
    get: unavailable,
    patch: unavailable,
    post: unavailable,
    put: unavailable,
  } as ApiClient
  const markup = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        ApiClientProvider,
        { client: apiClient },
        createElement(SpaceSettingsDialog, {
          canManageAccess: false,
          onClose: () => undefined,
          onSave: async () => undefined,
          open: true,
          space,
        }),
      ),
    ),
  )

  assert.match(markup, /Space settings/)
  assert.match(markup, /Shared reference material/)
  assert.doesNotMatch(markup, /Restrict editing/)
  assert.doesNotMatch(markup, /People with access/)
  assert.doesNotMatch(markup, /Agents with access/)
})
