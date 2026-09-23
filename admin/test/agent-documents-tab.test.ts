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
import { buildAgentOpenAction } from '../src/components/features/knowledge/finder/finder-toolbar-actions.js'
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
  // Both mounts are the same Finder, parameterised by scope: the agent's tab
  // starts inside the agent's own folder, the project's inside the project's.
  assert.match(documents, /scope=\{\{ agentId, kind: 'agent', spaceId: selectedSpace\.id \}\}/)
  assert.match(projectDocs, /<KnowledgeProvider projectId=\{projectId\}>/)
  assert.match(projectDocs, /scope=\{\{ kind: 'project', projectId \}\}/)
})

test('agent documents show the honest unavailable state and no-secrets warning', () => {
  const documents = readSource('../src/components/features/agents/AgentDocumentsTab.tsx')

  assert.match(documents, /required document home is unavailable/)
  assert.doesNotMatch(documents, /ensure|createSpace|provision/i)
  assert.match(
    documents,
    /Documents can have narrower access than this agent\. Don’t store secrets here\./,
  )
  assert.match(documents, /selectedSpace\.canWrite/)
  assert.match(documents, /Read-only/)
})

test('an agent-owned space renders a working Open doorway in its column header', () => {
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
  const doorway = buildAgentOpenAction({
    onOpenAgent: (agentId: string) => { openedAgentId = agentId },
    ownerAgentId: space.ownerAgentId,
  })
  assert.ok(doorway)
  // The column header says exactly "Open" — "Open agent" was the global
  // toolbar's wording, and the doorway lives in the column now.
  assert.equal(doorway.label, 'Open')

  const markup = renderToStaticMarkup(
    createElement(ResponsivePageHeader, { actions: [doorway], title: space.name }),
  )
  assert.match(markup, />Open</)

  doorway.onSelect()
  assert.equal(openedAgentId, ownerAgentId)
})

test('the Open doorway is absent where the column would offer to open the agent you are on', () => {
  const ownerAgentId = '00000000-0000-4000-8000-000000000005'
  const noop = () => undefined

  // The scoping agent's own Documents tab: opening it would be a doorway to
  // the page you are already standing on.
  assert.equal(
    buildAgentOpenAction({ onOpenAgent: noop, ownerAgentId, scopeAgentId: ownerAgentId }),
    null,
  )
  // Browsing the same agent's folder from anywhere else keeps the doorway.
  assert.ok(buildAgentOpenAction({ onOpenAgent: noop, ownerAgentId }))
  assert.ok(
    buildAgentOpenAction({ onOpenAgent: noop, ownerAgentId, scopeAgentId: 'another-agent' }),
  )
  // An ordinary space has no agent to open.
  assert.equal(buildAgentOpenAction({ onOpenAgent: noop, ownerAgentId: null }), null)
  assert.equal(buildAgentOpenAction({ onOpenAgent: noop, ownerAgentId: undefined }), null)
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

test('a system-managed agent exposes its two code-owned files as read-only projections', () => {
  const agentId = '00000000-0000-4000-8000-000000000005'
  const queryClient = new QueryClient()
  queryClient.setQueryData(agentKeys.documents(agentId), {
    projectedCoreDocuments: [
      { filename: 'AGENTS.md', markdown: 'Protect the platform boundary.', role: 'identity' },
      { filename: 'personality.md', markdown: 'Calm, direct, and precise.', role: 'working_rules' },
    ],
    space: null,
  })
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
          agent: { id: agentId, name: 'Librarian', systemManaged: true } as AgentRecord,
        }),
      ),
    ),
  )

  assert.match(markup, /code-owned and read-only/)
  assert.match(markup, /AGENTS\.md/)
  assert.match(markup, /Protect the platform boundary\./)
  assert.match(markup, /personality\.md/)
  assert.match(markup, /Calm, direct, and precise\./)
})
