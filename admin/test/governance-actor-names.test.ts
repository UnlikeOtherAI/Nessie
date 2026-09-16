import assert from 'node:assert/strict'
import test from 'node:test'

import { JSDOM } from 'jsdom'
import type { ApiClient } from '@nessie/client-core'

/**
 * `/approvals` and `/audit` name their actors.
 *
 * Both screens exist to answer "who" — which agent is asking for permission,
 * which agent did this — and both used to answer with eight characters of a
 * uuid (`Agent: a0000000`, `agent:a0000000 → email_message`) while every other
 * surface in the admin showed the agent's name. These tests pin the three
 * things that were wrong and the one that must not become wrong:
 *
 * 1. an ordinary agent is named;
 * 2. the Personal Assistant is named, although `GET /api/agents` omits it —
 *    the reason resolution goes through `AgentIdentityProvider` and not a map
 *    built from the agents list;
 * 3. a person, a service and a named system component read as themselves;
 * 4. an actor no directory can name still shows its id, never a blank or a
 *    generic word, and the exact id stays reachable on every row.
 */

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:5455/audit',
})

const React = await import('react')
const { createElement } = React
const { renderToStaticMarkup } = await import('react-dom/server')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { MemoryRouter } = await import('react-router-dom')
const { ApiClientProvider } = await import('@nessie/client-core')

const { AgentIdentityProvider } = await import('../src/providers/AgentIdentityProvider.js')
const { ToastProvider } = await import('../src/providers/ToastProvider.js')
const { AuthSessionProvider } = await import('../src/providers/AuthSessionProvider.js')
const { AuditEventList } = await import('../src/components/features/audit/AuditEventList.js')
const { ApprovalGate } = await import('../src/components/features/channels/ApprovalGate.js')
const { agentKeys } = await import('../src/facades/agents/keys.js')
const { approvalKeys } = await import('../src/facades/approvals/keys.js')
const { personalAssistantKeys } = await import('../src/facades/personal-assistant/keys.js')
const { userKeys } = await import('../src/facades/users/keys.js')

// The production Vite transform injects the JSX runtime. Node's lightweight
// tsx loader uses the classic transform for imported TSX modules.
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const SALES_AGENT = 'a0000000-0000-4000-8000-000000000001'
// The Personal Assistant is `systemManaged`: it is absent from the agents
// list on purpose and arrives only through its own facade.
const ASSISTANT = 'a0000000-0000-4000-8000-000000000002'
const DELETED_AGENT = 'a0000000-0000-4000-8000-000000000009'
const PERSON = 'b0000000-0000-4000-8000-000000000001'

const unusedApiClient = {
  delete: async () => {
    throw new Error('unexpected request')
  },
  get: async () => {
    throw new Error('unexpected request')
  },
  patch: async () => {
    throw new Error('unexpected request')
  },
  post: async () => {
    throw new Error('unexpected request')
  },
  put: async () => {
    throw new Error('unexpected request')
  },
} as unknown as ApiClient

/** Seeds the directories every actor resolves through. */
const directories = (): QueryClient => {
  const queryClient = new QueryClient()
  queryClient.setQueryData(agentKeys.allScopes, [
    { id: SALES_AGENT, name: 'Sales Assistant', role: 'Sales' },
  ])
  queryClient.setQueryData(agentKeys.all, [
    { id: SALES_AGENT, name: 'Sales Assistant', role: 'Sales' },
  ])
  queryClient.setQueryData(personalAssistantKeys.all, {
    agent: { id: ASSISTANT, name: 'Personal Assistant', role: 'Assistant' },
  })
  queryClient.setQueryData(userKeys.all, [
    { avatarUrl: null, displayName: 'Ondrej Rafaj', email: 'o@example.com', id: PERSON },
  ])
  return queryClient
}

const withLocalStorage = <T,>(run: () => T): T => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: dom.window.localStorage,
    writable: true,
  })
  try {
    return run()
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
}

/** The name and its kind word are separate elements; this is how they read. */
const reads = (name: string, kind: string): RegExp =>
  new RegExp(`>${name}</span> · ${kind}<`)

const entry = (fields: Record<string, unknown>) => ({
  action: 'email.sent',
  createdAt: '2026-09-16T09:00:00.000Z',
  metadata: null,
  outcome: 'success',
  resourceId: null,
  resourceType: 'email_message',
  ...fields,
})

const renderAuditRows = (entries: ReturnType<typeof entry>[]): string =>
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: directories() },
      createElement(
        ApiClientProvider,
        { client: unusedApiClient },
        createElement(
          AgentIdentityProvider,
          null,
          createElement(AuditEventList, { entries }),
        ),
      ),
    ),
  )

test('an audit row names the agent that acted', () => {
  const markup = renderAuditRows([
    entry({ actorId: SALES_AGENT, actorType: 'agent', id: 'e1' }),
  ])

  assert.match(markup, reads('Sales Assistant', 'agent'))
  // The shape the screen shipped with, which is the whole defect.
  assert.doesNotMatch(markup, /agent:a0000000/)
})

test('the Personal Assistant is named although the agents list omits it', () => {
  const markup = renderAuditRows([
    entry({ actorId: ASSISTANT, actorType: 'agent', id: 'e2' }),
  ])

  assert.match(markup, reads('Personal Assistant', 'agent'))
  assert.doesNotMatch(markup, />a0000000</)
})

test('a person, a service and a named system component read as themselves', () => {
  const markup = renderAuditRows([
    entry({ action: 'organization.updated', actorId: PERSON, actorType: 'user', id: 'e3' }),
    // Inbound agent email acts as a service under the agent's own id.
    entry({ actorId: SALES_AGENT, actorType: 'service', id: 'e4' }),
    entry({
      action: 'organization.automatic_membership.grant_issued',
      actorId: 'automatic-membership',
      actorType: 'system',
      id: 'e5',
    }),
  ])

  assert.match(markup, reads('Ondrej Rafaj', 'person'))
  assert.match(markup, reads('Sales Assistant', 'service'))
  assert.match(markup, reads('automatic-membership', 'system'))
})

test('an actor no directory can name keeps its id, and every row keeps the exact one', () => {
  const markup = renderAuditRows([
    entry({ actorId: DELETED_AGENT, actorType: 'agent', id: 'e6' }),
  ])

  // Not blank, and not a generic "Agent": the row must still say which one.
  assert.match(markup, reads('a0000000', 'agent'))
  assert.match(markup, new RegExp(`title="agent ${DELETED_AGENT}"`))
})

test('a named actor still carries its exact id for the row it belongs to', () => {
  const markup = renderAuditRows([
    entry({ actorId: SALES_AGENT, actorType: 'agent', id: 'e7', resourceId: DELETED_AGENT }),
  ])

  assert.match(markup, new RegExp(`title="agent ${SALES_AGENT}"`))
  assert.match(markup, new RegExp(`title="email_message ${DELETED_AGENT}"`))
})

const pendingApproval = (agentId: string | null) => ({
  action: 'mailbox_send',
  agentAccessCredentialId: agentId ? null : 'c0000000-0000-4000-8000-000000000001',
  agentId,
  channelId: null,
  context: null,
  createdAt: '2026-09-16T09:00:00.000Z',
  expiresAt: '2036-09-16T09:30:00.000Z',
  id: 'd0000000-0000-4000-8000-000000000001',
  organizationId: 'o0000000-0000-4000-8000-000000000001',
  projectId: null,
  reason: 'Send the quote to the customer',
  requesterId: PERSON,
  requiredApproverRole: null,
  resolution: null,
  resolutionNote: null,
  resolvedAt: null,
  resolverId: null,
  runId: null,
  status: 'pending',
  taskId: null,
  teamId: null,
  toolName: null,
  updatedAt: '2026-09-16T09:00:00.000Z',
})

const renderApprovalCard = (agentId: string | null): string => {
  const queryClient = directories()
  queryClient.setQueryData(approvalKeys.detail(pendingApproval(agentId).id), pendingApproval(agentId))

  return withLocalStorage(() => renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        MemoryRouter,
        { initialEntries: ['/channels/c1'] },
        createElement(
          AuthSessionProvider,
          null,
          createElement(
            ApiClientProvider,
            { client: unusedApiClient },
            createElement(
              ToastProvider,
              null,
              createElement(
              AgentIdentityProvider,
              null,
              createElement(ApprovalGate, {
                metadata: {
                  approvalGate: {
                    action: 'tool.invoke',
                    approvalId: pendingApproval(agentId).id,
                    status: 'pending',
                    toolName: 'mailbox_send',
                  },
                },
              }),
            ),
            ),
          ),
        ),
      ),
    ),
  ))
}

test('the approval card names the agent that is asking', () => {
  const markup = renderApprovalCard(SALES_AGENT)

  assert.match(markup, reads('Sales Assistant', 'agent'))
  assert.doesNotMatch(markup, /Agent: a0000000/)
  assert.match(markup, new RegExp(`title="agent ${SALES_AGENT}"`))
})

test('a paired-agent request names no agent rather than an id', () => {
  const markup = renderApprovalCard(null)

  assert.match(markup, /Needs your approval/)
  assert.doesNotMatch(markup, /· agent/)
})
