import {
  DEEP_WATER_DEFAULT_BRIEF_SETTINGS,
  DeepWaterBriefViewSchema,
  DeepWaterResearchRunViewSchema,
  type DeepWaterBriefView,
  type DeepWaterResearchRunView,
} from '@nessie/schemas'

/**
 * The research views the research-brief fixture serves, each parsed through
 * the strict schema the API answers with, so the screenshots can only show
 * states a server can send. Ids are fixed so the runner can address them.
 */

export const ORG = '10000000-0000-4000-8000-000000000001'
export const TEAM = '10000000-0000-4000-8000-000000000002'
export const ME = '20000000-0000-4000-8000-000000000001'
export const JANA = '20000000-0000-4000-8000-000000000002'
export const PA_AGENT = '30000000-0000-4000-8000-000000000001'
export const CHANNEL = '40000000-0000-4000-8000-000000000001'
export const THREAD = '40000000-0000-4000-8000-000000000002'
export const DM_CHANNEL = '40000000-0000-4000-8000-000000000003'
export const DM_THREAD = '40000000-0000-4000-8000-000000000004'
export const FAILED_ROOT = '60000000-0000-4000-8000-000000000098'

export const RUN = {
  agentDraft: '50000000-0000-4000-8000-000000000002',
  done: '50000000-0000-4000-8000-000000000003',
  draft: '50000000-0000-4000-8000-000000000001',
  failed: '50000000-0000-4000-8000-000000000005',
  hidden: '50000000-0000-4000-8000-000000000009',
  created: '50000000-0000-4000-8000-000000000010',
  running: '50000000-0000-4000-8000-000000000006',
  summary: '50000000-0000-4000-8000-000000000004',
} as const

export const PUBLIC_URL = 'https://research.deepwater.live/heat-pumps-in-victorian-terraces-5a3c9f10'

const at = (minutes: number) => new Date(Date.UTC(2026, 8, 23, 9, minutes)).toISOString()

const noViewer = { canCancel: false, canEdit: false, canRetryDelivery: false, canStart: false }
const ownDraftViewer = { canCancel: true, canEdit: true, canRetryDelivery: false, canStart: true }

export const run = (overrides: Partial<DeepWaterResearchRunView>): DeepWaterResearchRunView =>
  DeepWaterResearchRunViewSchema.parse({
    artifacts: null,
    completedAt: null,
    createdAt: at(0),
    delivery: { blockedReason: null, state: 'pending' },
    failure: null,
    id: RUN.draft,
    origin: {
      agentId: null, cardMessageId: null, channelId: CHANNEL, kind: 'person', rootMessageId: null, threadId: THREAD,
    },
    pillarCount: 3,
    publicUrl: null,
    report: null,
    reportKind: null,
    requestedByUserId: ME,
    settings: DEEP_WATER_DEFAULT_BRIEF_SETTINGS,
    sourceCount: null,
    startedAt: null,
    status: 'drafting',
    title: null,
    topic: 'How well do heat pumps work in Victorian terraced houses?',
    truncated: false,
    viewer: ownDraftViewer,
    ...overrides,
  })

const agentOrigin = {
  agentId: PA_AGENT, cardMessageId: null, channelId: CHANNEL, kind: 'agent' as const, rootMessageId: null,
  threadId: THREAD,
}

const finished = {
  artifacts: { report: true, sources: true },
  completedAt: at(58),
  delivery: { blockedReason: null, state: 'delivered' as const },
  report: { pageId: '70000000-0000-4000-8000-000000000002', spaceId: '70000000-0000-4000-8000-000000000001' },
  startedAt: at(12),
  status: 'completed' as const,
  viewer: noViewer,
}

/** The launched and finished research the thread and Knowledge › Research show. */
export const listedRuns = (): DeepWaterResearchRunView[] => [
  run({
    ...finished,
    createdAt: at(40),
    id: RUN.done,
    publicUrl: PUBLIC_URL,
    reportKind: 'full',
    sourceCount: 48,
    title: 'Heat pumps in Victorian terraced houses',
  }),
  run({
    ...finished,
    createdAt: at(30),
    id: RUN.summary,
    reportKind: 'summary',
    sourceCount: 17,
    title: 'Grants for heat pumps in the UK',
    topic: 'Which grants help with a heat pump in the UK?',
    truncated: true,
  }),
  run({
    createdAt: at(20),
    id: RUN.running,
    origin: agentOrigin,
    startedAt: at(21),
    status: 'running',
    title: 'Installer shortages in England',
    topic: 'Are there enough heat pump installers in England?',
    viewer: { ...noViewer, canCancel: true },
  }),
  run({
    createdAt: at(10),
    failure: { code: 'failed', message: 'DeepWater couldn’t finish this research. You can start it again.' },
    id: RUN.failed,
    // Asked in a reply thread: Start again comes back under the same root.
    origin: {
      agentId: null, cardMessageId: null, channelId: CHANNEL, kind: 'person', rootMessageId: FAILED_ROOT, threadId: THREAD,
    },
    status: 'failed',
    topic: 'Noise from air-source heat pumps in terraces',
    viewer: noViewer,
  }),
]

const DRAFT_MESSAGES: DeepWaterBriefView['messages'] = [
  {
    author: { kind: 'person', userId: ME },
    content: 'How well do heat pumps work in Victorian terraced houses?',
    createdAt: at(0),
    id: '60000000-0000-4000-8000-000000000001',
  },
  {
    author: { kind: 'planner' },
    content: 'Good question. I’d split it into **costs and grants**, **performance in solid-wall houses** and '
      + '**installation**. One thing changes the research a lot: which country should I focus on?',
    createdAt: at(1),
    id: '60000000-0000-4000-8000-000000000002',
  },
]

/** The person's own brief, being agreed. */
export const draftBrief = (overrides: Partial<DeepWaterBriefView> = {}): DeepWaterBriefView =>
  DeepWaterBriefViewSchema.parse({
    ...run({}),
    analysis: {
      approach: 'Compare field trials of heat pumps in solid-wall homes with manufacturers’ figures and '
        + 'government statistics.',
      caveats: ['Few trials cover houses built before 1919.', 'Running costs move with energy prices.'],
      complexity: 'medium',
      dataFreshness: 'Mostly the last five years',
      estimatedReliability: 'Good for costs, weaker for comfort',
      recommendedDepth: 'deep',
      sourceTypes: ['Field trials', 'Government statistics', 'Installer surveys'],
    },
    lockedSettings: ['outputLanguage'],
    messages: DRAFT_MESSAGES,
    openQuestions: [
      {
        question: 'Which country should the research focus on?',
        suggestedAnswers: ['The UK', 'England only', 'Northern Europe'],
        why: 'Grants, building rules and energy prices differ by country.',
      },
    ],
    pendingAction: null,
    pillars: ['Costs and grants', 'Performance in solid-wall houses', 'Installation and disruption'],
    planner: { displayName: 'DeepWater’s research planner', iconUrl: null },
    plannerTurn: { status: 'idle' },
    ready: false,
    revision: 2,
    settings: { ...DEEP_WATER_DEFAULT_BRIEF_SETTINGS, outputLanguage: 'en' },
    ...overrides,
  })

type ReplyEdits = { pillars?: string[]; settings?: Partial<DeepWaterBriefView['settings']> }

/**
 * The planner's answer to the person's reply: DeepWater applies the reply's
 * edits first (one revision, locking what the person set), then the planner's
 * turn moves the brief on again — a newer brief, ready to start.
 */
export const answeredBrief = (
  previous: DeepWaterBriefView,
  reply: string,
  edits: ReplyEdits,
): DeepWaterBriefView => {
  const pillars = edits.pillars ?? previous.pillars
  const locked = [...new Set([...previous.lockedSettings, ...Object.keys(edits.settings ?? {})])]
  return DeepWaterBriefViewSchema.parse({
    ...previous,
    lockedSettings: locked,
    messages: [
      ...previous.messages,
      {
        author: { kind: 'person', userId: ME },
        content: reply,
        createdAt: at(3),
        id: '60000000-0000-4000-8000-000000000003',
      },
      {
        author: { kind: 'planner' },
        content: 'Thanks — I’ll focus on the UK and add a chapter on **the planning rules** for listed and '
          + 'conservation-area homes. I suggest going deep: field data is thin.',
        createdAt: at(4),
        id: '60000000-0000-4000-8000-000000000004',
      },
    ],
    openQuestions: [],
    pendingAction: null,
    pillars: [...pillars, 'Planning rules for listed and conservation-area homes'],
    pillarCount: pillars.length + 1,
    plannerTurn: { status: 'idle' },
    ready: true,
    revision: (previous.revision ?? 0) + 2,
    settings: { ...previous.settings!, ...edits.settings, depth: 'deep' },
  })
}

/** An agent's brief, seen by the person it works for: read-only, cancellable. */
export const agentBrief = (): DeepWaterBriefView =>
  draftBrief({
    id: RUN.agentDraft,
    messages: [
      {
        author: { agentId: PA_AGENT, kind: 'agent' },
        content: 'Research the heat pump market for small UK landlords: costs, grants and tenant disruption.',
        createdAt: at(0),
        id: '60000000-0000-4000-8000-000000000011',
      },
      DRAFT_MESSAGES[1]!,
    ],
    origin: agentOrigin,
    topic: 'Heat pumps for small UK landlords',
    viewer: { ...noViewer, canCancel: true },
  })

export const createdBrief = (topic: string): DeepWaterBriefView =>
  DeepWaterBriefViewSchema.parse({
    ...draftBrief(),
    analysis: null,
    id: RUN.created,
    lockedSettings: [],
    messages: [{ author: { kind: 'person', userId: ME }, content: topic, createdAt: at(5),
      id: '60000000-0000-4000-8000-000000000021' }],
    openQuestions: [],
    pendingAction: { actionId: '80000000-0000-4000-8000-000000000001', error: null, kind: 'scope_start',
      since: new Date(Date.now() - 4_000).toISOString() },
    pillarCount: 0,
    pillars: [],
    plannerTurn: { actionId: '80000000-0000-4000-8000-000000000001', since: new Date(Date.now() - 4_000).toISOString(),
      status: 'replying' },
    revision: null,
    settings: null,
    topic,
  })

export const REPORT_MARKDOWN = [
  '# Heat pumps in Victorian terraced houses',
  '',
  '## Costs and grants',
  '',
  'The Boiler Upgrade Scheme pays £7,500 towards an air-source heat pump in England and Wales.',
].join('\n')
