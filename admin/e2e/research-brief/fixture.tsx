import { ApiClientError, ApiClientProvider, type ApiClient } from '@nessie/client-core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import {
  DeepWaterResearchRunViewSchema,
  type AppDetailRecord,
  type DeepWaterBriefView,
  type DeepWaterResearchReadinessState,
  type DeepWaterResearchRunView,
} from '@nessie/schemas'

import { AppDetailHero } from '../../src/components/features/apps/AppDetailHero'
import { ResearchBriefHost } from '../../src/components/features/deep-water/ResearchBriefHost'
import { ResearchNoticeActions, ResearchRunCard } from '../../src/components/features/deep-water/ResearchRunCard'
import { useResearchComposerButton } from '../../src/components/features/deep-water/useResearchComposerButton'
import { DeepWaterResearchView } from '../../src/components/features/knowledge/DeepWaterResearchView'
import { invalidateResearchRun } from '../../src/facades/deep-water/events'
import { AgentIdentityProvider } from '../../src/providers/AgentIdentityProvider'
import { AuthSessionProvider } from '../../src/providers/AuthSessionProvider'
import '../../src/styles.css'
import {
  CHANNEL, JANA, ME, PA_AGENT, REPORT_MARKDOWN, RUN, TEAM, THREAD,
  agentBrief, answeredBrief, createdBrief, draftBrief, listedRuns,
} from './fixture-data'

/**
 * DeepWater research in the admin, over a stubbed API (Water plan nessie.md
 * §7.7, §7.9). The real brief dialog, research card, notice actions,
 * Knowledge › Research view and `/apps/deep-water` hero render; only the
 * transport is fake. The runner drives the server's side through
 * `window.__research` — the planner answering, the launch landing, a revision
 * conflict — and each change reaches the screen the way a realtime
 * `integration.run.updated` does, through `invalidateResearchRun`.
 *
 * `?at=` is the address the memory router starts at; `?readiness=` and
 * `?owner=1` set the server's verdict on the products list; `?brief=` picks the
 * person's brief (`drafting`, `failed`, `sign-in`).
 */

const params = new URLSearchParams(location.search)
const readiness = (params.get('readiness') ?? 'ready') as DeepWaterResearchReadinessState
const owner = params.get('owner') === '1'
const briefVariant = params.get('brief') ?? 'drafting'
try {
  window.localStorage.clear()
  window.localStorage.setItem('nessie.admin.token', 'research-brief-fixture')
} catch {
  // Without storage there is no session; the runner's first wait fails loudly.
}

const toRun = (brief: DeepWaterBriefView): DeepWaterResearchRunView =>
  DeepWaterResearchRunViewSchema.strip().parse(brief)

const personBrief = (): DeepWaterBriefView => {
  if (briefVariant === 'failed') {
    return draftBrief({
      plannerTurn: { actionId: null, message: 'DeepWater’s research planner couldn’t answer just now. Send your '
        + 'message again to retry.', retryable: true, status: 'failed' },
    })
  }
  if (briefVariant === 'sign-in') {
    return draftBrief({ delivery: { blockedReason: 'requester_identity_changed', state: 'blocked' } })
  }
  return draftBrief()
}

const briefs = new Map<string, DeepWaterBriefView>([[RUN.draft, personBrief()], [RUN.agentDraft, agentBrief()]])
const runs = new Map<string, DeepWaterResearchRunView>(listedRuns().map((entry) => [entry.id, entry]))
const store = { conflictNext: false, teamEnabled: readiness !== 'team_off' }
const calls: { body?: unknown; method: string; path: string }[] = []

const runView = (id: string): DeepWaterResearchRunView | null => {
  const brief = briefs.get(id)
  return brief ? toRun(brief) : runs.get(id) ?? null
}
const notFound = () => new ApiClientError('Not found', 'DEEP_WATER_RESEARCH_NOT_FOUND', 404)

const product = () => ({
  capabilities: [], category: 'research', id: '90000000-0000-4000-8000-000000000001', name: 'DeepWater',
  // Turned on here, a team that started off is ready; otherwise the verdict the run asked for.
  research: {
    state: store.teamEnabled ? (readiness === 'team_off' ? 'ready' : readiness) : 'team_off',
    viewerCanChangeTeam: owner,
  },
  slug: 'deep-water', summary: 'Deep research, agreed first.',
  teamEnablement: { enabled: store.teamEnabled, teamId: TEAM },
})

const RUNS = '/api/integrations/products/deep-water/research-runs'

const get = async (path: string): Promise<unknown> => {
  calls.push({ method: 'GET', path })
  const route = new URL(path, location.origin).pathname
  if (route === '/api/integrations/products') return [product()]
  if (route === '/api/users') {
    return [{ displayName: 'Ondřej Rafaj', id: ME }, { displayName: 'Jana Nováková', id: JANA }]
  }
  if (route === '/api/agents') return [{ id: PA_AGENT, name: 'Personal Assistant', status: 'idle' }]
  if (route === '/api/personal-assistant') return null
  const match = new RegExp(`^${RUNS}/([^/]+)(/brief|/artifacts/report)?$`).exec(route)
  if (match) {
    const [, id = '', tail] = match
    if (tail === '/brief') {
      const brief = briefs.get(id) ?? null
      if (brief) return brief
      throw notFound()
    }
    const view = runView(id)
    if (!view) throw notFound()
    if (tail === '/artifacts/report') return { markdown: REPORT_MARKDOWN, reportKind: view.reportKind, truncated: false }
    return view
  }
  return []
}

const updateBrief = (id: string, update: (brief: DeepWaterBriefView) => DeepWaterBriefView): DeepWaterBriefView => {
  const brief = briefs.get(id)
  if (!brief) throw notFound()
  const next = update(brief)
  briefs.set(id, next)
  return next
}

const conflict = (id: string) => {
  store.conflictNext = false
  // DeepWater's planner moved the brief on while the person was editing.
  const moved = updateBrief(id, (brief) => ({
    ...brief, revision: (brief.revision ?? 0) + 1, settings: { ...brief.settings!, depth: 'heavy' },
  }))
  return new ApiClientError('The brief changed', 'DEEP_WATER_BRIEF_REVISION_CONFLICT', 409,
    { currentRevision: moved.revision })
}

const post = async (path: string, body?: Record<string, unknown>): Promise<unknown> => {
  calls.push({ body, method: 'POST', path })
  const route = new URL(path, location.origin).pathname
  if (route === RUNS) {
    const created = createdBrief(String(body?.topic))
    briefs.set(created.id, created)
    return created
  }
  const match = new RegExp(`^${RUNS}/([^/]+)/(messages|start|cancel|deliver)$`).exec(route)
  const [, id = '', action] = match ?? []
  const since = new Date().toISOString()
  const actionId = String(body?.actionId)
  if (action === 'messages') {
    if (store.conflictNext) throw conflict(id)
    return updateBrief(id, (brief) => ({
      ...brief,
      pendingAction: { actionId, error: null, kind: 'reply', since },
      plannerTurn: { actionId, since, status: 'replying' },
      viewer: { ...brief.viewer, canEdit: false, canStart: false },
    }))
  }
  if (action === 'start') {
    if (store.conflictNext) throw conflict(id)
    return toRun(updateBrief(id, (brief) => ({
      ...brief, pendingAction: { actionId, error: null, kind: 'launch', since }, status: 'starting',
    })))
  }
  if (action === 'cancel') {
    const brief = briefs.get(id)
    if (brief) return toRun(updateBrief(id, (entry) => ({ ...entry, status: 'cancelled', viewer: { ...entry.viewer,
      canCancel: false, canEdit: false, canStart: false } })))
    const view = runs.get(id)
    if (!view) throw notFound()
    runs.set(id, { ...view, status: 'cancelled', viewer: { ...view.viewer, canCancel: false } })
    return { id, status: 'cancelled' }
  }
  if (action === 'deliver') {
    return toRun(updateBrief(id, (brief) => ({ ...brief, delivery: { blockedReason: null, state: 'pending' } })))
  }
  return { ok: true }
}

const patch = async (path: string, body?: Record<string, unknown>): Promise<unknown> => {
  calls.push({ body, method: 'PATCH', path })
  // Turning DeepWater off would strand the agent's running research.
  if (body?.enabled === false && runs.get(RUN.running)?.status === 'running') {
    throw new ApiClientError('Deep Water run is still running', 'LEDGER_DEEPWATER_ACTIVE_RUNS', 409, {
      channelId: CHANNEL, id: RUN.running, originKind: 'agent', requestedByUserId: ME, status: 'running',
    })
  }
  store.teamEnabled = body?.enabled === true
  return product()
}

const client = {
  delete: async () => null,
  get,
  getPage: async (path: string) => {
    calls.push({ method: 'GET', path })
    const own = [...briefs.values()].filter((brief) => brief.status !== 'cancelled').map(toRun)
    return { data: { items: [...own, ...runs.values()], meta: { hasMore: false, nextCursor: null, prevCursor: null } } }
  },
  patch,
  post,
  put: async () => null,
} as unknown as ApiClient

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

/** The server's side, driven by the runner; each change reaches the screen as the realtime event does. */
Object.assign(window, {
  __research: {
    calls,
    conflictNext: () => {
      store.conflictNext = true
    },
    launched: (id: string) => {
      updateBrief(id, (brief) => ({ ...brief, pendingAction: null, startedAt: new Date().toISOString(),
        status: 'running', viewer: { ...brief.viewer, canEdit: false, canStart: false } }))
      invalidateResearchRun(queryClient, id)
    },
    plannerAnswers: (id: string) => {
      const reply = calls.filter((call) => call.method === 'POST' && call.path.endsWith(`${id}/messages`)).at(-1)
      const body = (reply?.body ?? {}) as { message?: string; pillars?: string[]; settings?: object }
      updateBrief(id, (brief) => ({
        ...answeredBrief(brief, String(body.message), { pillars: body.pillars, settings: body.settings }),
        viewer: { ...brief.viewer, canEdit: true, canStart: true },
      }))
      invalidateResearchRun(queryClient, id)
    },
  },
})

const COMPOSER_TEXT = 'Could we look into heat pumps for the Leeds office before winter?'

const REPLY_ROOT = '60000000-0000-4000-8000-000000000099'

/**
 * The composer's Research button, as `ChannelComposer` draws it from the same
 * hook — the conversation's, or a reply thread's (`rootMessageId`).
 */
const ComposerStrip = ({ rootMessageId, testId }: { rootMessageId?: string; testId: string }) => {
  const [message, setMessage] = useState(rootMessageId ? 'Compare the three quotes we got' : COMPOSER_TEXT)
  const button = useResearchComposerButton(message, rootMessageId)
  return (
    <div className="flex items-center gap-2 rounded-xl border border-[color:var(--sep)] bg-[color:var(--panel)] p-2">
      <input
        aria-label="Message"
        className="admin-input flex-1"
        onChange={(event) => setMessage(event.target.value)}
        value={message}
      />
      {button ? (
        <button
          aria-label={button.title}
          className="admin-button admin-button-secondary"
          data-testid={testId}
          onClick={button.onOpen}
          title={button.title}
          type="button"
        >
          Research
        </button>
      ) : null}
    </div>
  )
}

const CARDS = [RUN.draft, RUN.agentDraft, RUN.running, RUN.done, RUN.summary, RUN.failed, RUN.hidden]

const Thread = () => (
  <ResearchBriefHost origin={{ channelId: CHANNEL, kind: 'thread', threadId: THREAD }}>
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6" data-testid="research-thread">
      {CARDS.map((id) => (
        <div data-card={id} key={id}>
          <ResearchRunCard metadata={{ researchRunRef: { runId: id, schemaVersion: 1 } }} />
        </div>
      ))}
      <div data-notice={RUN.done}>
        <p className="text-sm text-[color:var(--tx)]">
          @Ondřej Rafaj Your research “Heat pumps in Victorian terraced houses” has finished. The full report is
          in Documents.
        </p>
        <ResearchNoticeActions metadata={{ deepWaterNotice: { kind: 'result', runId: RUN.done, schemaVersion: 1 } }} />
      </div>
      <ComposerStrip testId="composer-research-button" />
      <ComposerStrip rootMessageId={REPLY_ROOT} testId="reply-research-button" />
    </div>
  </ResearchBriefHost>
)

const deepWaterApp = {
  agentsWithAccess: [], aliases: [], appSource: 'first_party', authMethod: 'none',
  capabilities: { tools: [] }, categories: ['ai_search'], connectionCount: 0, connections: [],
  displayName: 'DeepWater', distribution: 'builtin', documentationUrl: null, featured: true, featuredOrder: 1,
  iconUrl: null, id: '90000000-0000-4000-8000-000000000002', locked: false,
  longDescription: 'Deep research that you agree with DeepWater’s planner before it starts, delivered back to '
    + 'the conversation that asked for it.',
  managedByIntegration: true, name: 'deep-water', primaryCategory: 'ai_search', promptCount: null,
  repositoryUrl: null, resourceCount: null, setupSurface: null, shortDescription: 'Deep research.',
  slug: 'deep-water', state: 'available', tags: [], toolCount: 8, trustLevel: 'verified', vendor: 'UnlikeOtherAI',
  websiteUrl: null,
} as unknown as AppDetailRecord

const Hero = () => (
  <div className="mx-auto max-w-4xl p-6">
    <AppDetailHero app={deepWaterApp} onConnect={() => undefined} onRemove={() => undefined} removing={false} />
  </div>
)

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <AuthSessionProvider>
      <ApiClientProvider client={client}>
        <AgentIdentityProvider>
          <MemoryRouter initialEntries={[params.get('at') ?? `/channels/${CHANNEL}`]}>
            <div data-ready="true" style={{ background: 'var(--main)', minHeight: '100vh' }}>
              <Routes>
                <Route element={<Thread />} path="/channels/:channelId" />
                <Route element={<DeepWaterResearchView />} path="/knowledge-base/views/deep-water-research" />
                <Route element={<Hero />} path="/apps/deep-water" />
              </Routes>
            </div>
          </MemoryRouter>
        </AgentIdentityProvider>
      </ApiClientProvider>
    </AuthSessionProvider>
  </QueryClientProvider>,
)
