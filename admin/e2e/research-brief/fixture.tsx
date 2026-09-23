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
import { FeedConversationContext } from '../../src/components/features/channels/feed-conversation'
import { MessageUiCards } from '../../src/components/features/channels/MessageUiCards'
import { ResearchBriefHost } from '../../src/components/features/deep-water/ResearchBriefHost'
import { ResearchNoticeActions, ResearchRunCard } from '../../src/components/features/deep-water/ResearchRunCard'
import type { NewBriefPlace } from '../../src/components/features/deep-water/research-brief-origin'
import { useResearchComposerButton } from '../../src/components/features/deep-water/useResearchComposerButton'
import { DeepWaterResearchView } from '../../src/components/features/knowledge/DeepWaterResearchView'
import { invalidateResearchRun } from '../../src/facades/deep-water/events'
import { AgentIdentityProvider } from '../../src/providers/AgentIdentityProvider'
import { AuthSessionProvider } from '../../src/providers/AuthSessionProvider'
import '../../src/styles.css'
import {
  CHANNEL, DM_CHANNEL, DM_THREAD, JANA, ME, PA_AGENT, REPORT_MARKDOWN, RUN, TEAM, THREAD,
  agentBrief, answeredBrief, createdBrief, draftBrief, listedRuns, olderLauncherRuns,
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
 * `?at=` is the address the memory router starts at; `?readiness=` sets the
 * server's verdict on the products list, and `?owner=1` or `?admin=1` the
 * viewer's role (the runner's `/api/auth/me` answers with it) and so the
 * verdict's cancel standing; `?brief=` picks the
 * person's brief (`drafting`, `opening-failed` — the planner could not answer
 * the question that opened it — or `sign-in`); `?agent=sign-in` blocks the
 * agent's brief on its requester's changed sign-in; `?create=` makes opening a
 * brief lose its first answer (`lost-once`, after the brief was opened) or be
 * refused because DeepWater was turned off meanwhile (`not-ready`); `?many=1`
 * adds enough older research for a second page of Knowledge › Research at ten
 * a page.
 *
 * Opening a brief is idempotent by its `actionId`, as the API is: the same key
 * again answers with the brief it already opened.
 *
 * A cancel is answered as the API answers it: accepted (202) with the research
 * still open and the cancel in flight; the runner settles it later
 * (`cancelSettles`), as DeepWater stopping the research does.
 */

const params = new URLSearchParams(location.search)
const readiness = (params.get('readiness') ?? 'ready') as DeepWaterResearchReadinessState
const owner = params.get('owner') === '1'
const admin = params.get('admin') === '1'
const briefVariant = params.get('brief') ?? 'drafting'
const agentVariant = params.get('agent')
const createVariant = params.get('create')
const many = params.get('many') === '1'
try {
  window.localStorage.clear()
  window.localStorage.setItem('nessie.admin.token', 'research-brief-fixture')
} catch {
  // Without storage there is no session; the runner's first wait fails loudly.
}

const toRun = (brief: DeepWaterBriefView): DeepWaterResearchRunView =>
  DeepWaterResearchRunViewSchema.strip().parse(brief)

/** Nessie's words for a planner turn that stalled (`deepWaterPlannerFailureMessage`). */
const PLANNER_STALLED = 'DeepWater’s research planner stopped responding before it answered.'
const failedTurn = { actionId: null, message: PLANNER_STALLED, retryable: true, status: 'failed' } as const

const personBrief = (): DeepWaterBriefView => {
  if (briefVariant === 'opening-failed') {
    // No turn has been answered: the transcript is empty and the brief is as it was opened.
    return draftBrief({
      analysis: null, lockedSettings: [], messages: [], openQuestions: [], pillarCount: 0, pillars: [],
      plannerTurn: failedTurn, revision: 0,
    })
  }
  if (briefVariant === 'sign-in') {
    return draftBrief({ delivery: { blockedReason: 'requester_identity_changed', state: 'blocked' } })
  }
  return draftBrief()
}

const agentsBrief = (): DeepWaterBriefView => {
  const brief = agentBrief()
  return agentVariant === 'sign-in'
    ? { ...brief, delivery: { blockedReason: 'requester_identity_changed', state: 'blocked' },
      viewer: { ...brief.viewer, canRetryDelivery: true } }
    : brief
}

const briefs = new Map<string, DeepWaterBriefView>([[RUN.draft, personBrief()], [RUN.agentDraft, agentsBrief()]])
const runs = new Map<string, DeepWaterResearchRunView>(
  [...listedRuns(), ...(many ? olderLauncherRuns(8) : [])].map((entry) => [entry.id, entry]),
)
const store = { conflictNext: false, createLost: createVariant === 'lost-once', teamEnabled: readiness !== 'team_off',
  upgraded: false }
/** The brief each opening key opened: the same key again is answered with it. */
const opened = new Map<string, DeepWaterBriefView>()
const calls: { body?: unknown; method: string; path: string }[] = []

const runView = (id: string): DeepWaterResearchRunView | null => {
  const brief = briefs.get(id)
  return brief ? toRun(brief) : runs.get(id) ?? null
}
const notFound = () => new ApiClientError('Not found', 'DEEP_WATER_RESEARCH_NOT_FOUND', 404)

const product = () => ({
  capabilities: [], category: 'research', id: '90000000-0000-4000-8000-000000000001', name: 'DeepWater',
  // Turned on (or updated) here, a team is ready; otherwise the verdict the run asked for.
  research: {
    state: !store.teamEnabled ? 'team_off' : readiness === 'team_off' || store.upgraded ? 'ready' : readiness,
    // The cancel standing: owners and admins (amendments N8.5).
    viewerCanChangeTeam: owner || admin,
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
    const key = String(body?.actionId)
    const replay = opened.get(key)
    if (replay) return briefs.get(replay.id) ?? replay
    if (createVariant === 'not-ready') {
      // DeepWater was turned off for the team after the products list was read.
      store.teamEnabled = false
      throw new ApiClientError('DeepWater is off', 'DEEP_WATER_NOT_READY', 409, { reason: 'team_off' })
    }
    const created = createdBrief(String(body?.topic))
    briefs.set(created.id, created)
    opened.set(key, created)
    if (store.createLost) {
      // Opened, but the answer never came back.
      store.createLost = false
      throw new TypeError('Failed to fetch')
    }
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
    // Accepted: the research stays open, with the cancel in flight, until DeepWater stops it.
    const brief = briefs.get(id)
    if (brief) {
      return toRun(updateBrief(id, (entry) => ({
        ...entry,
        pendingAction: { actionId, error: null, kind: 'cancel', since },
        viewer: { ...entry.viewer, canEdit: false, canStart: false },
      })))
    }
    const view = runs.get(id)
    if (!view) throw notFound()
    return view
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
  // Turning it on installs the current research tools, which is how a team is updated.
  if (store.teamEnabled) store.upgraded = true
  return product()
}

const client = {
  delete: async () => null,
  get,
  // Forward only, as the brief API pages: a cursor names the last row of the page before.
  getPage: async (path: string) => {
    calls.push({ method: 'GET', path })
    const query = new URL(path, location.origin).searchParams
    const limit = Number(query.get('limit') ?? '25')
    const own = [...briefs.values()].filter((brief) => brief.status !== 'cancelled').map(toRun)
    const all = [...own, ...runs.values()]
    const after = query.get('cursor')
    const start = after ? all.findIndex((entry) => entry.id === after) + 1 : 0
    const items = all.slice(start, start + limit)
    const hasMore = start + limit < all.length
    return {
      data: { items, meta: { hasMore, nextCursor: hasMore ? items.at(-1)?.id ?? null : null, prevCursor: null } },
    }
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
    /** How many briefs opening a brief has opened: a replayed key opens none. */
    openedBriefs: () => opened.size,
    /** DeepWater stops a research whose cancel was accepted. */
    cancelSettles: (id: string) => {
      if (briefs.has(id)) {
        updateBrief(id, (brief) => ({ ...brief, pendingAction: null, status: 'cancelled',
          viewer: { ...brief.viewer, canCancel: false, canEdit: false, canStart: false } }))
      } else {
        const view = runs.get(id)
        if (view) runs.set(id, { ...view, status: 'cancelled', viewer: { ...view.viewer, canCancel: false } })
      }
      invalidateResearchRun(queryClient, id)
    },
    conflictNext: () => {
      store.conflictNext = true
    },
    launched: (id: string) => {
      updateBrief(id, (brief) => ({ ...brief, pendingAction: null, startedAt: new Date().toISOString(),
        status: 'running', viewer: { ...brief.viewer, canEdit: false, canStart: false } }))
      invalidateResearchRun(queryClient, id)
    },
    /** DeepWater's planner stalls on the person's last reply: no transcript row, the action cleared. */
    plannerFails: (id: string) => {
      updateBrief(id, (brief) => ({
        ...brief,
        pendingAction: null,
        plannerTurn: failedTurn,
        viewer: { ...brief.viewer, canEdit: true, canStart: true },
      }))
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

/** A conversation other than the one on screen: a person's DM drawer, or a Threads inbox card's reply thread. */
const ELSEWHERE: NewBriefPlace = {
  origin: { channelId: DM_CHANNEL, kind: 'thread', rootMessageId: REPLY_ROOT, threadId: DM_THREAD },
}

/**
 * The composer's Research button, as `ChannelComposer` draws it from the same
 * hook — the conversation's, a reply thread's (`rootMessageId`), or one over
 * another conversation (`ELSEWHERE`).
 */
const ComposerStrip = ({ place, testId, text = COMPOSER_TEXT }: {
  place?: NewBriefPlace
  testId: string
  text?: string
}) => {
  const [message, setMessage] = useState(text)
  const button = useResearchComposerButton(message, place)
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

const OLD_CARD_ROOT = '60000000-0000-4000-8000-000000000097'

/** An older DeepWater card, from before briefs, in a reply thread of another conversation (a drawer, an inbox card). */
const OLDER_CARD = {
  uiCards: [{
    actions: [{
      label: 'Run again', preset: { query: 'Heat pump grants for landlords' },
      type: 'open_deep_water_research_launcher', variant: 'primary',
    }],
    kind: 'deep_research', productSlug: 'deep-water', status: 'completed', title: 'Heat pump grants for landlords',
  }],
}

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
      <ComposerStrip
        place={{ rootMessageId: REPLY_ROOT }}
        testId="reply-research-button"
        text="Compare the three quotes we got"
      />
      <ComposerStrip place={ELSEWHERE} testId="elsewhere-research-button" text="What do tenants pay to heat a flat?" />
      <FeedConversationContext.Provider value={{ channelId: DM_CHANNEL }}>
        <div data-testid="older-card">
          <MessageUiCards metadata={OLDER_CARD} place={{ rootMessageId: OLD_CARD_ROOT, threadId: DM_THREAD }} />
        </div>
      </FeedConversationContext.Provider>
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
