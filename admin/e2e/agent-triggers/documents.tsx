import { ApiClientError } from '@nessie/client-core'
import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

import { TriggerDetail } from '../../src/components/features/triggers/TriggerDetail'
import type { AgentRecord, AgentTriggerRecord, ChannelRecord } from '../../src/lib/api-client'
import { ProjectDocsTab } from '../../src/pages/project/ProjectDocsTab'
import { ToastProvider } from '../../src/providers/ToastProvider'

/**
 * The document-trigger half of the agent-triggers fixture
 * (docs/plans/2026-09-23-ticket-driven-agents/setup-and-ui.md, T2): the
 * project's Documents, a document trigger's page, and the stubbed answers
 * behind them. The real `ProjectDocsTab` — the same Finder the Knowledge
 * section renders — draws the row badges from the Finder read and opens the
 * real Triggers editor from a row's menu.
 *
 * The project has three spaces: its own Documents space ("Engineering docs"),
 * a team-only "Leadership" space no public channel may watch, and "Research",
 * which the stub refuses on the space field the way the server refuses a space
 * the agent cannot read.
 */

export const PROJECT = '60000000-0000-4000-8000-000000000011'
const ORG = '60000000-0000-4000-8000-000000000010'
export const DOCS_SPACE = '60000000-0000-4000-8000-000000000501'
export const LEADS_SPACE = '60000000-0000-4000-8000-000000000502'
export const RESEARCH_SPACE = '60000000-0000-4000-8000-000000000503'
export const SPECS = '60000000-0000-4000-8000-000000000511'
const API_FOLDER = '60000000-0000-4000-8000-000000000512'
export const ARCHITECTURE = '60000000-0000-4000-8000-000000000513'
export const RELEASE_NOTES = '60000000-0000-4000-8000-000000000514'
const ROADMAP = '60000000-0000-4000-8000-000000000515'
export const BUDGET = '60000000-0000-4000-8000-000000000516'
const PAYMENTS = '60000000-0000-4000-8000-000000000517'
export const DOCUMENT_TRIGGER = '60000000-0000-4000-8000-000000000520'
export const REVIEW_THREAD = '60000000-0000-4000-8000-000000000530'
export const REVIEW_CHANNEL = '60000000-0000-4000-8000-000000000002'
const T0 = '2026-09-24T08:00:00.000Z'

const space = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  canManageAccess: false, canWrite: true, channelId: null, createdAt: T0, createdBy: 'user', deletedAt: null,
  description: null, id, memberAgentIds: [], memberUserIds: [], metadata: null, name, organizationId: ORG,
  ownerAgentId: null, policyChainTrace: [], privateToAgentId: null, projectId: PROJECT, sensitivityTier: 'normal',
  sourceRef: `space:${id}`, teamId: null, threadId: null, updatedAt: T0, userId: null, visibility: 'project',
  visibilityReason: 'project members', writeRestricted: false, ...extra,
})
export const spaces = [
  space(DOCS_SPACE, 'Engineering docs', { metadata: { projectDocuments: true } }),
  space(LEADS_SPACE, 'Leadership', { visibility: 'team' }),
  space(RESEARCH_SPACE, 'Research'),
]

const page = (id: string, title: string, kind: string, parentPageId: string | null, labels: string[] = []) => ({
  createdAt: T0, id, indexing: undefined, kind, labels, latestVersion: null, metadata: null, parentPageId,
  policyChainTrace: [], position: 0, publishedVersion: null, publishedVersionId: null, revision: 1, shareCount: 0,
  sizeBytes: kind === 'file' ? '2048' : null, sourceRef: `page:${id}`, spaceId: DOCS_SPACE, status: 'published',
  summary: null, title, updatedAt: T0, visibilityReason: 'space readers',
})
export const pages = [
  page(SPECS, 'Specs', 'folder', null),
  page(API_FOLDER, 'API', 'folder', SPECS),
  page(PAYMENTS, 'Payments spec', 'document', SPECS, ['spec']),
  page(ARCHITECTURE, 'Architecture', 'document', null, ['spec']),
  page(RELEASE_NOTES, 'Release notes.md', 'file', null),
  page(ROADMAP, 'Roadmap', 'document', null, ['planning']),
  page(BUDGET, 'Budget', 'spreadsheet', null),
]

/** The newest review of two root pages: one in a thread the viewer may open, one in a thread they may not. */
const reviews = (agentId: string) => [
  {
    agent: { id: agentId, name: 'CTO' }, pageId: ARCHITECTURE, reviewedAt: '2026-09-24T09:12:00.000Z',
    thread: { channelId: REVIEW_CHANNEL, id: REVIEW_THREAD }, triggerId: DOCUMENT_TRIGGER, versionNumber: 5,
  },
  {
    agent: { id: agentId, name: 'CTO' }, pageId: RELEASE_NOTES, reviewedAt: '2026-09-24T09:40:00.000Z',
    thread: null, triggerId: DOCUMENT_TRIGGER, versionNumber: 2,
  },
]

export const documentTrigger = {
  agentId: '60000000-0000-4000-8000-000000000001',
  config: {
    fireOn: 'save', folderPageId: SPECS, includeAgentEdits: false, instructions: { general: 'Review the change.' },
    kinds: ['document', 'file'], labels: ['spec'], pageIds: null, quietSeconds: 300, spaceId: DOCS_SPACE,
  },
  createdAt: T0, description: 'Reviews edits to the specs.', enabled: true, id: DOCUMENT_TRIGGER, lastFiredAt: T0,
  name: 'Review spec changes', status: 'active', targetChannelId: REVIEW_CHANNEL, type: 'document_changed', updatedAt: T0,
} as unknown as AgentTriggerRecord

const delivery = (n: number, status: string, payload: Record<string, unknown>) => ({
  createdAt: `2026-09-24T1${n}:00:00.000Z`, id: `60000000-0000-4000-8000-0000000006${n}0`,
  payload: {
    authorKinds: ['person'], bodyChars: 4200, fireOn: 'save', fromVersionId: `60000000-0000-4000-8000-0000000007${n}0`,
    fromVersionNumber: 3 + n, kind: 'document', pageId: PAYMENTS, projectId: PROJECT, spaceId: DOCS_SPACE, taskId: null,
    toVersionId: `60000000-0000-4000-8000-0000000008${n}0`, toVersionNumber: 4 + n, versionsCoalesced: 1, ...payload,
  },
  source: 'document', status, triggerId: DOCUMENT_TRIGGER,
  ...(status === 'skipped' ? { errorMessage: String(payload.skipReason) } : {}),
})
const documentHistory = [
  delivery(3, 'delivered', { outcome: 'page_thread', threadId: REVIEW_THREAD, versionsCoalesced: 3 }),
  delivery(2, 'delivered', {
    outcome: 'ticket_work', taskId: '60000000-0000-4000-8000-000000000101', threadId: REVIEW_THREAD,
    workId: '60000000-0000-4000-8000-000000000400',
  }),
  delivery(1, 'skipped', { authorKinds: [], outcome: 'skipped', skipReason: 'agent_edits_only' }),
]

type FixtureState = { location?: string; reads: string[] }

/** The knowledge answers, or undefined for a path this half does not serve. */
export const documentGet = (url: URL, state: FixtureState, agentId: string): unknown => {
  const route = url.pathname
  if (route === '/api/knowledge-base/spaces') return spaces
  const match = /^\/api\/knowledge-base\/spaces\/([^/]+)(\/.*)?$/.exec(route)
  if (match) {
    const [, id, rest] = match
    if (!rest) return spaces.find((candidate) => candidate.id === id)
    if (rest === '/pages') return id === DOCS_SPACE ? pages : []
    if (rest === '/document-triggers') {
      state.reads.push(`${id}?${url.searchParams.get('pageIds') ?? ''}`)
      const asked = new Set((url.searchParams.get('pageIds') ?? '').split(',').filter(Boolean))
      return {
        projectId: PROJECT,
        reviews: id === DOCS_SPACE ? reviews(agentId).filter((review) => asked.has(review.pageId)) : [],
        viewerCanCreateTriggers: new URLSearchParams(location.search).get('owner') !== '0',
      }
    }
  }
  if (route === `/api/triggers/${DOCUMENT_TRIGGER}/history`) return documentHistory
  return undefined
}

/** What `resolveDocumentChangedTrigger` answers for a space the agent cannot read. */
export const refuseDocumentCreate = (body: { config?: { spaceId?: string }; type?: string }): void => {
  if (body.type !== 'document_changed' || body.config?.spaceId !== RESEARCH_SPACE) return
  const refusal = {
    path: 'spaceId',
    reason: 'CTO cannot read space Research; bind it to a channel of the project, or share the space with it',
  }
  throw new ApiClientError(`${refusal.path}: ${refusal.reason}`, 'TRIGGER_CONFIG_REFUSED', 400, { refusals: [refusal] })
}

/** Where the router is, for the runner: a badge or a menu item that navigates says so here. */
const LocationProbe = ({ state }: { state: FixtureState }) => {
  const location = useLocation()
  useEffect(() => {
    state.location = `${location.pathname}${location.search}`
  }, [location, state])
  return null
}

export const DocsScenario = ({ state }: { state: FixtureState }) => (
  <ToastProvider>
    <LocationProbe state={state} />
    <div className="flex h-screen min-h-0 flex-col">
      <ProjectDocsTab projectId={PROJECT} />
    </div>
  </ToastProvider>
)

export const DocumentDetailScenario = ({ agents, channels }: { agents: AgentRecord[]; channels: ChannelRecord[] }) => (
  <div className="p-6">
    <TriggerDetail
      registry={{
        agentsById: new Map(agents.map((agent) => [agent.id, agent])),
        channelsById: new Map(channels.map((channel) => [channel.id, channel])),
        workflowInstallationsById: new Map(),
        workflowTemplatesById: new Map(),
      }}
      trigger={documentTrigger}
    />
  </div>
)
