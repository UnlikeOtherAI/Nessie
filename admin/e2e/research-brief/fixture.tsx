import { ApiClientProvider } from '@nessie/client-core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom'
import type { AppDetailRecord } from '@nessie/schemas'

import { AppDetailHero } from '../../src/components/features/apps/AppDetailHero'
import { FeedConversationContext } from '../../src/components/features/channels/feed-conversation'
import { MessageUiCards } from '../../src/components/features/channels/MessageUiCards'
import { ResearchBriefHost } from '../../src/components/features/deep-water/ResearchBriefHost'
import { ResearchNoticeActions, ResearchRunCard } from '../../src/components/features/deep-water/ResearchRunCard'
import type { NewBriefPlace } from '../../src/components/features/deep-water/research-brief-origin'
import { useResearchComposerButton } from '../../src/components/features/deep-water/useResearchComposerButton'
import { DeepWaterResearchView } from '../../src/components/features/knowledge/DeepWaterResearchView'
import { useTrackLocationKey } from '../../src/navigation/redirect'
import { AgentIdentityProvider } from '../../src/providers/AgentIdentityProvider'
import { AuthSessionProvider } from '../../src/providers/AuthSessionProvider'
import '../../src/styles.css'
import { CHANNEL, DM_CHANNEL, DM_THREAD, RUN, THREAD } from './fixture-data'
import { createFixtureServer } from './fixture-server'

/**
 * DeepWater research in the admin, over a stubbed API (Water plan nessie.md
 * §7.7, §7.9). The real brief dialog, research card, notice actions,
 * Knowledge › Research view and `/apps/deep-water` hero render; only the
 * transport is fake (`fixture-server.ts`, which also reads the query switches
 * that shape the server's answers). The runner drives the server's side
 * through `window.__research`.
 *
 * `?at=` is the address the memory router starts at. The routes are the
 * admin's own addresses for the screens a brief opens over — a conversation,
 * one of its threads, a reply thread, the Threads inbox and Knowledge ›
 * Research — plus `/elsewhere`, a screen with no brief host, whose older card
 * hands its question to the conversation in router state. The router's
 * location is readable, and history walkable, through `window.__research`
 * (`location`, `go`), and the shell's location-key tracking runs as it does in
 * the app, so a redirect that drops a handed-over question behaves as it does
 * there.
 */

const params = new URLSearchParams(location.search)
try {
  window.localStorage.clear()
  window.localStorage.setItem('nessie.admin.token', 'research-brief-fixture')
} catch {
  // Without storage there is no session; the runner's first wait fails loudly.
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
const { client, runner } = createFixtureServer(queryClient)
const research: Record<string, unknown> = { ...runner }
Object.assign(window, { __research: research })

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

const OlderCard = () => (
  <FeedConversationContext.Provider value={{ channelId: DM_CHANNEL }}>
    <div data-testid="older-card">
      <MessageUiCards metadata={OLDER_CARD} place={{ rootMessageId: OLD_CARD_ROOT, threadId: DM_THREAD }} />
    </div>
  </FeedConversationContext.Provider>
)

/**
 * A conversation, as `ChannelsPage` hosts it: `/channels/:channelId` is the
 * room's own thread, and a thread or reply-thread address names its thread.
 */
const Thread = () => {
  const { channelId, threadId } = useParams()
  const origin = channelId && threadId
    ? { channelId, kind: 'thread' as const, threadId }
    : { channelId: CHANNEL, kind: 'thread' as const, threadId: THREAD }
  return (
    <ResearchBriefHost origin={origin}>
      <ThreadBody />
    </ResearchBriefHost>
  )
}

const ThreadBody = () => (
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
    <OlderCard />
  </div>
)

/** The Threads inbox, as `ThreadsPage` hosts it: no conversation of its own; a card's composer names its thread. */
const Inbox = () => (
  <ResearchBriefHost origin={null}>
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6" data-testid="research-inbox">
      <ComposerStrip place={ELSEWHERE} testId="inbox-research-button" text="What do tenants pay to heat a flat?" />
    </div>
  </ResearchBriefHost>
)

/** A screen with no brief host: an older card here sends its question to its own conversation. */
const Elsewhere = () => (
  <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6" data-testid="research-elsewhere">
    <OlderCard />
  </div>
)

/** The router's location and history, for the runner; and the shell's key tracking a redirect relies on. */
const LocationProbe = () => {
  useTrackLocationKey()
  const current = useLocation()
  const navigate = useNavigate()
  research.location = () => ({ pathname: current.pathname, search: current.search, state: current.state })
  research.go = (delta: number) => void navigate(delta)
  return null
}

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
              <LocationProbe />
              <Routes>
                <Route element={<Thread />} path="/channels/:channelId" />
                <Route element={<Thread />} path="/channels/:channelId/threads/:threadId" />
                <Route element={<Thread />} path="/channels/:channelId/threads/:threadId/replies/:rootMessageId" />
                <Route element={<Inbox />} path="/threads" />
                <Route element={<Elsewhere />} path="/elsewhere" />
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
