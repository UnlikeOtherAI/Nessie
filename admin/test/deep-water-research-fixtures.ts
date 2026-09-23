import {
  DEEP_WATER_DEFAULT_BRIEF_SETTINGS,
  DeepWaterBriefViewSchema,
  DeepWaterResearchRunViewSchema,
  type DeepWaterBriefView,
  type DeepWaterResearchRunView,
} from '@nessie/schemas'

/**
 * DeepWater research views for the admin's tests, parsed through the same
 * strict schemas the API answers with, so a fixture that drifts from the
 * contract fails here rather than rendering something no server can send.
 */

export const REQUESTER = '20000000-0000-4000-8000-000000000001'
export const COLLEAGUE = '20000000-0000-4000-8000-000000000002'
export const AGENT = '30000000-0000-4000-8000-000000000001'
export const RUN_ID = '10000000-0000-4000-8000-000000000001'
export const CHANNEL = '40000000-0000-4000-8000-000000000001'
export const THREAD = '40000000-0000-4000-8000-000000000002'

export const researchRun = (overrides: Partial<DeepWaterResearchRunView> = {}): DeepWaterResearchRunView =>
  DeepWaterResearchRunViewSchema.parse({
    artifacts: null,
    cancelFailure: null,
    completedAt: null,
    createdAt: '2026-09-23T09:00:00.000Z',
    delivery: { blockedReason: null, state: 'pending' },
    failure: null,
    id: RUN_ID,
    origin: {
      agentId: null,
      cardMessageId: null,
      channelId: CHANNEL,
      kind: 'person',
      rootMessageId: null,
      threadId: THREAD,
    },
    pillarCount: 3,
    progress: null,
    publicUrl: null,
    report: null,
    reportKind: null,
    requestedByUserId: REQUESTER,
    settings: DEEP_WATER_DEFAULT_BRIEF_SETTINGS,
    sourceCount: null,
    startedAt: null,
    status: 'drafting',
    title: null,
    topic: 'How well do heat pumps work in Victorian terraces?',
    truncated: false,
    viewer: { canCancel: true, canEdit: true, canRetryDelivery: false, canStart: true },
    ...overrides,
  })

export const completedRun = (overrides: Partial<DeepWaterResearchRunView> = {}): DeepWaterResearchRunView =>
  researchRun({
    artifacts: { report: true, sources: true },
    completedAt: '2026-09-23T10:00:00.000Z',
    delivery: { blockedReason: null, state: 'delivered' },
    report: {
      pageId: '50000000-0000-4000-8000-000000000002',
      spaceId: '50000000-0000-4000-8000-000000000001',
    },
    reportKind: 'full',
    sourceCount: 42,
    startedAt: '2026-09-23T09:10:00.000Z',
    status: 'completed',
    title: 'Heat pumps in Victorian terraces',
    viewer: { canCancel: false, canEdit: false, canRetryDelivery: false, canStart: false },
    ...overrides,
  })

export const researchBrief = (overrides: Partial<DeepWaterBriefView> = {}): DeepWaterBriefView =>
  DeepWaterBriefViewSchema.parse({
    ...researchRun(),
    analysis: {
      approach: 'Compare field trials with manufacturers’ figures.',
      caveats: ['Few trials cover solid-wall houses.'],
      complexity: 'medium',
      dataFreshness: 'Mostly the last five years',
      estimatedReliability: 'Good for costs, weaker for comfort',
      recommendedDepth: 'deep',
      sourceTypes: ['Field trials', 'Government statistics'],
    },
    lockedSettings: ['outputLanguage'],
    messages: [
      {
        author: { kind: 'person', userId: REQUESTER },
        content: 'How well do heat pumps work in Victorian terraces?',
        createdAt: '2026-09-23T09:00:00.000Z',
        id: '60000000-0000-4000-8000-000000000001',
      },
      {
        author: { kind: 'planner' },
        content: 'I suggest three pillars. **Which country** should I focus on?',
        createdAt: '2026-09-23T09:01:00.000Z',
        id: '60000000-0000-4000-8000-000000000002',
      },
    ],
    openQuestions: [
      {
        question: 'Which country should the research focus on?',
        suggestedAnswers: ['The UK', 'Europe'],
        why: 'Grants and building rules differ.',
      },
    ],
    pendingAction: null,
    pillars: ['Costs and grants', 'Performance in solid-wall houses', 'Installation'],
    planner: { displayName: 'DeepWater’s research planner', iconUrl: null },
    plannerTurn: { status: 'idle' },
    ready: true,
    revision: 2,
    settings: { ...DEEP_WATER_DEFAULT_BRIEF_SETTINGS, outputLanguage: 'cs' },
    ...overrides,
  })
