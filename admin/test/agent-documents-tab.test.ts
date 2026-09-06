import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { ApiClientProvider, type ApiClient } from '@nessie/client-core'
import { KnowledgeSpaceResponseSchema } from '@nessie/schemas'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { AgentDocumentsTab } from '../src/components/features/agents/AgentDocumentsTab.js'
import { buildKnowledgeWorkspaceActions } from '../src/components/features/knowledge/knowledge-workspace-actions.js'
import { ResponsivePageHeader } from '../src/components/shared/ResponsivePageHeader.js'
import { agentKeys } from '../src/facades/agents/keys.js'
import type { AgentRecord } from '../src/lib/api-client.js'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('agent detail mounts documents through the shared knowledge team seam', () => {
  const tabs = readSource('../src/components/features/agents/AgentDetailTabs.tsx')
  const documents = readSource('../src/components/features/agents/AgentDocumentsTab.tsx')
  const projectDocs = readSource('../src/pages/project/ProjectDocsTab.tsx')

  assert.match(tabs, /label: 'Documents', value: 'documents'/)
  assert.match(tabs, /documents: \{/)
  assert.match(documents, /<KnowledgeProvider agentId=\{agent\.id\} spaceId=\{space\.id\}>/)
  assert.match(documents, /<KnowledgeWorkspace canManageSpace=\{isOwner\} \/>/)
  assert.match(projectDocs, /<KnowledgeProvider projectId=\{projectId\}>/)
  assert.match(projectDocs, /<KnowledgeWorkspace \/>/)
})

test('agent documents show the honest empty state and no-secrets warning', () => {
  const documents = readSource('../src/components/features/agents/AgentDocumentsTab.tsx')

  assert.match(documents, /has no document space yet/)
  assert.doesNotMatch(documents, /ensure|createSpace|provision/i)
  assert.match(
    documents,
    /These documents are visible to everyone who can see this agent\. Don’t store secrets here\./,
  )
  assert.match(documents, /selectedSpace\.canWrite/)
  assert.match(documents, /Read-only/)
})

test('an agent-owned space renders a working Open agent doorway from the shared contract', () => {
  const ownerAgentId = '00000000-0000-4000-8000-000000000005'
  const space = KnowledgeSpaceResponseSchema.parse({
    id: '00000000-0000-4000-8000-000000000006',
    ownerAgentId,
    name: 'Researcher — Documents',
    description: null,
    metadata: { agentDocs: true },
    writeRestricted: false,
    memberUserIds: [],
    memberAgentIds: [],
    canWrite: true,
    canManageAccess: true,
    organizationId: '00000000-0000-4000-8000-000000000001',
    projectId: '00000000-0000-4000-8000-000000000002',
    visibility: 'private',
    sensitivityTier: 'normal',
    createdBy: ownerAgentId,
    deletedAt: null,
    sourceRef: 'kb://first-party/spaces/space',
    visibilityReason: 'private visibility',
    policyChainTrace: ['decision:ALLOWED'],
    createdAt: '2026-08-31T12:00:00.000Z',
    updatedAt: '2026-08-31T12:00:00.000Z',
  })
  let openedAgentId: string | null = null
  const noop = () => undefined
  const actions = buildKnowledgeWorkspaceActions({
    agentDraftCount: 0,
    canManageSpace: true,
    canWrite: space.canWrite,
    needsReviewOnly: false,
    onCreateFolder: noop,
    onCreatePage: noop,
    onOpenAgent: (agentId) => { openedAgentId = agentId },
    onOpenSettings: noop,
    onSelectView: noop,
    onToggleNeedsReview: noop,
    onUploadFile: noop,
    ownerAgentId: space.ownerAgentId,
    selectedSpaceId: space.id,
    viewMode: 'column',
  })

  const markup = renderToStaticMarkup(
    createElement(ResponsivePageHeader, { actions, title: space.name }),
  )
  assert.match(markup, />Open agent</)

  const doorway = actions?.find((action) => action.id === 'open-agent')
  assert.ok(doorway && doorway.kind !== 'menu')
  doorway.onSelect()
  assert.equal(openedAgentId, ownerAgentId)
})

test('the agent Documents tab renders the honest unreadable state', () => {
  const agentId = '00000000-0000-4000-8000-000000000005'
  const queryClient = new QueryClient()
  queryClient.setQueryData(agentKeys.documents(agentId), { space: { canRead: false } })
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
        createElement(AgentDocumentsTab, {
          agent: { id: agentId, name: 'Researcher' } as AgentRecord,
        }),
      ),
    ),
  )

  assert.match(markup, /You can see this agent, but you don’t have access to its documents\./)
  assert.doesNotMatch(markup, /Loading documents/)
})
