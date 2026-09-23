import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CreateDeepWaterBriefRequestSchema,
  DeepWaterBriefActionJobPayloadSchema,
  DeepWaterBriefReplyRequestSchema,
  DeepWaterBriefSettingsEditSchema,
  DeepWaterDeliveryMessageMetadataSchema,
  DeepWaterRequesterIdentitySchema,
  DeepWaterScopeStateSchema,
  LedgerResearchReportSchema,
  LedgerResearchStatusDtoSchema,
  LedgerResearchTicketSchema,
  LedgerScopeResultSchema,
  LedgerToolErrorSchema,
  ProductIntegrationRunStatusSchema,
  ResearchRunRefMessageMetadataSchema,
  StartDeepWaterBriefRequestSchema,
  deepWaterReplyAction,
  emptyDeepWaterScopeState,
  isResearchRunRefMessage,
  toLedgerBriefSettings,
} from '../index.js'

const RUN_ID = '0b5f2f1e-6a1e-4c55-9d52-2a4b1e0c6a01'
const TURN_ID = '0b5f2f1e-6a1e-4c55-9d52-2a4b1e0c6a02'
const MESSAGE_ID = '0b5f2f1e-6a1e-4c55-9d52-2a4b1e0c6a03'
const ACTION_ID = '0b5f2f1e-6a1e-4c55-9d52-2a4b1e0c6a04'
const USER_ID = '0b5f2f1e-6a1e-4c55-9d52-2a4b1e0c6a05'

const wireSettings = {
  depth: 'deep',
  chapter_depth: 'detailed',
  search_quality: 'premium',
  languages: ['en', 'cs'],
  output_language: 'cs',
  recency: 'year',
  writing_style: 'executive',
}

const scopeResult = (overrides: Record<string, unknown> = {}) => ({
  id: 'rs_abc123',
  status: 'drafting',
  error_code: null,
  title: null,
  turn: {
    id: TURN_ID,
    seq: 2,
    status: 'complete',
    author_kind: 'agent',
    error_code: null,
    retryable: false,
  },
  brief: {
    state: 'drafting',
    revision: 3,
    topic: 'Heat pumps in older houses',
    reply: 'Here is a first cut of the brief.',
    pillars: ['Costs', 'Retrofit limits'],
    settings: wireSettings,
    locked_settings: ['depth', 'output_language', 'a_future_setting'],
    open_questions: [{ question: 'Which country?', why: 'Grants differ.', suggested_answers: ['UK', 'Czechia'] }],
    analysis: {
      approach: 'Survey then compare',
      complexity: 'Very high',
      source_types: ['government', 'trade press'],
      caveats: ['grant schemes change'],
      recommended_depth: 'deep',
      data_freshness: 'last two years',
      estimated_reliability: 'good',
    },
    ready: false,
    messages: [{
      id: MESSAGE_ID,
      seq: '12',
      turn_id: TURN_ID,
      role: 'planner',
      author_kind: null,
      event: null,
      content: 'Here is a first cut of the brief.',
      brief_revision: 3,
      created_at: '2026-09-23T10:00:00.000Z',
    }],
  },
  status_url: 'https://ledger.unlikeotherai.com/v1/research/rs_abc123',
  events_url: 'https://ledger.unlikeotherai.com/v1/research/rs_abc123/events',
  a_field_ledger_added_later: { anything: true },
  ...overrides,
})

test('LedgerScopeResultSchema maps the wire onto camelCase and ignores unknown fields', () => {
  const parsed = LedgerScopeResultSchema.parse(scopeResult())
  assert.equal(parsed.id, 'rs_abc123')
  assert.deepEqual(parsed.turn, {
    id: TURN_ID,
    seq: 2,
    status: 'complete',
    authorKind: 'agent',
    errorCode: null,
    retryable: false,
  })
  assert.deepEqual(parsed.brief?.settings, {
    depth: 'deep',
    chapterDepth: 'detailed',
    searchQuality: 'premium',
    languages: ['en', 'cs'],
    outputLanguage: 'cs',
    recency: 'year',
    writingStyle: 'executive',
  })
  // A lock on a setting Nessie cannot show is left out of the projection.
  assert.deepEqual(parsed.brief?.lockedSettings, ['depth', 'outputLanguage'])
  assert.equal(parsed.brief?.analysis?.complexity, 'very_high')
  assert.deepEqual(parsed.brief?.openQuestions[0]?.suggestedAnswers, ['UK', 'Czechia'])
  assert.equal(parsed.brief?.messages?.[0]?.seq, '12')
  assert.equal(parsed.brief?.messages?.[0]?.turnId, TURN_ID)
  assert.equal('a_field_ledger_added_later' in parsed, false)
})

test('LedgerScopeResultSchema tolerates absent later fields and a transcript-free read', () => {
  const raw = scopeResult()
  delete (raw as Record<string, unknown>).title
  delete (raw as Record<string, unknown>).error_code
  delete (raw.brief as Record<string, unknown>).messages
  const parsed = LedgerScopeResultSchema.parse(raw)
  assert.equal(parsed.title, null)
  assert.equal(parsed.errorCode, null)
  // Absent is not the same as empty: the stored transcript must survive it.
  assert.equal(parsed.brief?.messages, null)
  assert.equal(LedgerScopeResultSchema.parse(scopeResult({ brief: null, turn: null })).brief, null)
})

test('LedgerScopeResultSchema refuses values outside the contract', () => {
  assert.equal(LedgerScopeResultSchema.safeParse(scopeResult({ status: 'paused' })).success, false)
  assert.equal(LedgerScopeResultSchema.safeParse(scopeResult({ id: 'job_1' })).success, false)
  const turnWithoutSeq = { ...scopeResult().turn, seq: undefined }
  assert.equal(LedgerScopeResultSchema.safeParse(scopeResult({ turn: turnWithoutSeq })).success, false)
  const badDepth = { ...scopeResult().brief, settings: { ...wireSettings, depth: 'quick' } }
  assert.equal(LedgerScopeResultSchema.safeParse(scopeResult({ brief: badDepth })).success, false)
})

test('LedgerResearchStatusDtoSchema accepts only the public research origin', () => {
  const parsed = LedgerResearchStatusDtoSchema.parse({
    id: 'rs_abc123',
    status: 'complete',
    progress: { phase: 'done', sources_found: 41, at: '2026-09-23T10:00:00.000Z' },
    title: 'Heat pumps',
    public_url: 'https://research.deepwater.live/heat-pumps-ab12cd',
  })
  assert.equal(parsed.publicUrl, 'https://research.deepwater.live/heat-pumps-ab12cd')
  assert.equal(parsed.sourcesFound, 41)
  assert.equal(parsed.errorCode, null)
  assert.equal(parsed.brief, null)

  const drafting = LedgerResearchStatusDtoSchema.parse({
    id: 'rs_abc123',
    status: 'drafting',
    brief: { revision: null, turn_pending: true },
  })
  assert.deepEqual(drafting.brief, { revision: null, turnPending: true })
  assert.equal(drafting.title, null)
  assert.equal(drafting.publicUrl, null)

  for (const url of [
    'https://evil.example/heat-pumps',
    'http://research.deepwater.live/heat-pumps',
    'https://user:pw@research.deepwater.live/heat-pumps',
    'not a url',
    // Both parse to the right origin, but the stored column (and the delivery
    // claim) take only the literal origin followed by a path.
    'https://research.deepwater.live',
    'HTTPS://research.deepwater.live/heat-pumps',
    'https://research.deepwater.live.evil.example/heat-pumps',
  ]) {
    assert.equal(
      LedgerResearchStatusDtoSchema.safeParse({ id: 'rs_abc123', status: 'complete', public_url: url }).success,
      false,
      url,
    )
  }
})

test('LedgerResearchReportSchema maps references and reads report_kind per N10', () => {
  const base = {
    report_markdown: '# Heat pumps\n\nBody.',
    references: [{ title: 'Grant scheme', url: 'https://gov.example/grants', accessed_at: '2026-09-20T00:00:00Z' }],
    depth: 'deep',
    started_at: '2026-09-23T09:00:00.000Z',
    completed_at: '2026-09-23T10:00:00.000Z',
    truncated: false,
  }
  const legacy = LedgerResearchReportSchema.parse(base)
  assert.equal(legacy.reportKind, null)
  assert.equal(legacy.publicUrl, null)
  assert.deepEqual(legacy.references[0], {
    title: 'Grant scheme',
    url: 'https://gov.example/grants',
    accessedAt: '2026-09-20T00:00:00Z',
  })
  assert.equal(LedgerResearchReportSchema.parse({ ...base, report_kind: 'summary' }).reportKind, 'summary')
  assert.equal(LedgerResearchReportSchema.parse({ ...base, report_kind: 'abridged' }).reportKind, null)
  assert.equal(
    LedgerResearchReportSchema.parse({ ...base, full_report_error_code: 'under_min_word_count' }).fullReportErrorCode,
    'under_min_word_count',
  )
})

test('LedgerResearchTicketSchema requires id and job_id to name one research', () => {
  assert.deepEqual(
    LedgerResearchTicketSchema.parse({ id: 'rs_a', job_id: 'rs_a', status: 'running', eta_minutes: 20 }),
    { id: 'rs_a', status: 'running' },
  )
  assert.equal(LedgerResearchTicketSchema.safeParse({ id: 'rs_a', job_id: 'rs_b', status: 'running' }).success, false)
})

test('LedgerToolErrorSchema reads a revision conflict', () => {
  assert.deepEqual(
    LedgerToolErrorSchema.parse({ error: 'scope_revision_conflict', status_code: 409, current_revision: 6 }),
    { code: 'scope_revision_conflict', description: null, statusCode: 409, currentRevision: 6 },
  )
})

test('toLedgerBriefSettings writes only the keys present, keeping null as a lock release', () => {
  assert.deepEqual(
    toLedgerBriefSettings({ chapterDepth: 'brief', outputLanguage: null, depth: undefined }),
    { chapter_depth: 'brief', output_language: null },
  )
  assert.equal(DeepWaterBriefSettingsEditSchema.safeParse({}).success, false)
  assert.equal(DeepWaterBriefSettingsEditSchema.safeParse({ recency: null }).success, true)
  assert.equal(DeepWaterBriefSettingsEditSchema.safeParse({ languages: ['xx'] }).success, false)
})

test('brief requests are strict and require a base revision with edits', () => {
  assert.equal(CreateDeepWaterBriefRequestSchema.safeParse({
    actionId: ACTION_ID,
    origin: { kind: 'personal' },
    topic: '  Heat pumps  ',
    settings: { depth: 'light' },
  }).success, true)
  assert.equal(CreateDeepWaterBriefRequestSchema.safeParse({
    actionId: ACTION_ID,
    origin: { kind: 'personal' },
    topic: 'Heat pumps',
    title: 'not negotiable',
  }).success, false)
  assert.equal(CreateDeepWaterBriefRequestSchema.safeParse({
    actionId: ACTION_ID,
    origin: { kind: 'thread', channelId: RUN_ID },
    topic: 'Heat pumps',
  }).success, false)

  assert.equal(DeepWaterBriefReplyRequestSchema.safeParse({
    actionId: ACTION_ID,
    message: 'Focus on the UK',
    pillars: ['Costs'],
  }).success, false)
  assert.equal(DeepWaterBriefReplyRequestSchema.safeParse({
    actionId: ACTION_ID,
    message: 'Focus on the UK',
    baseRevision: 3,
    pillars: ['Costs'],
  }).success, true)
  assert.equal(StartDeepWaterBriefRequestSchema.safeParse({
    actionId: ACTION_ID,
    revision: 3,
    public: true,
  }).success, true)
})

test('the requester identity is stable UOA ids with a required epoch, nothing else', () => {
  const identity = { subject: 'uoa|123', organizationId: 'org_1', teamId: 'team_1', tokenVersion: 4 }
  assert.deepEqual(DeepWaterRequesterIdentitySchema.parse(identity), identity)
  assert.equal(DeepWaterRequesterIdentitySchema.safeParse({ ...identity, tokenVersion: null }).success, false)
  assert.equal(DeepWaterRequesterIdentitySchema.safeParse({ ...identity, email: 'a@b.c' }).success, false)
})

test('the empty scope state is what both insert paths write', () => {
  assert.deepEqual(DeepWaterScopeStateSchema.parse(emptyDeepWaterScopeState()), {
    brief: null,
    turn: null,
    turnAuthors: {},
    pendingAction: null,
    progress: null,
  })
})

test('a stored scope state carries DeepWater\'s latest progress, and one written before the push has none', () => {
  const before = { brief: null, turn: null, turnAuthors: {}, pendingAction: null }
  assert.equal(DeepWaterScopeStateSchema.parse(before).progress, null)
  const progress = {
    phase: 'writing_report', note: 'Finished chapter 3 of 8', percent: 38, sourcesFound: 31,
    at: '2026-09-23T10:16:00.000Z',
  }
  assert.deepEqual(DeepWaterScopeStateSchema.parse({ ...before, progress }).progress, progress)
  for (const wrong of [
    { ...progress, phase: 'thinking' },
    { ...progress, percent: 101 },
    { ...progress, sourcesFound: -1 },
    { ...progress, at: 'yesterday' },
    { ...progress, sources_found: 31 },
  ]) {
    const parsed = DeepWaterScopeStateSchema.safeParse({ ...before, progress: wrong })
    assert.equal(parsed.success, false, JSON.stringify(wrong))
  }
})

test('message pointers are strict and carry ids only', () => {
  const ref = { researchRunRef: { schemaVersion: 1, runId: RUN_ID } }
  assert.equal(ResearchRunRefMessageMetadataSchema.safeParse(ref).success, true)
  assert.equal(ResearchRunRefMessageMetadataSchema.safeParse({ ...ref, topic: 'x' }).success, false)
  assert.equal(isResearchRunRefMessage(ref), true)
  assert.equal(isResearchRunRefMessage({ ...ref, somethingElse: 1 }), true)
  assert.equal(isResearchRunRefMessage({ researchRunRef: { runId: 'nope' } }), false)
  assert.equal(isResearchRunRefMessage(null), false)

  const wake = (kind: string, turnId: string | null) => ({
    deepWaterDelivery: { schemaVersion: 1, runId: RUN_ID, kind, turnId },
  })
  assert.equal(DeepWaterDeliveryMessageMetadataSchema.safeParse(wake('turn', TURN_ID)).success, true)
  assert.equal(DeepWaterDeliveryMessageMetadataSchema.safeParse(wake('completed', null)).success, true)
  assert.equal(DeepWaterDeliveryMessageMetadataSchema.safeParse(wake('turn', null)).success, false)
  assert.equal(DeepWaterDeliveryMessageMetadataSchema.safeParse(wake('failed', TURN_ID)).success, false)
})

test('a brief action job lets an owner only cancel', () => {
  const payload = (role: string, action: Record<string, unknown>) => ({
    organizationId: RUN_ID,
    runId: RUN_ID,
    actionId: ACTION_ID,
    acceptedAt: '2026-09-23T09:00:00.000Z',
    actor: {
      userId: USER_ID,
      role,
      identity: { subject: 'uoa|1', organizationId: 'o', teamId: 't', tokenVersion: 0 },
    },
    action,
  })
  assert.equal(DeepWaterBriefActionJobPayloadSchema.safeParse(payload('owner', { kind: 'cancel' })).success, true)
  assert.equal(
    DeepWaterBriefActionJobPayloadSchema.safeParse(payload('owner', { kind: 'reply', message: 'hi' })).success,
    false,
  )
  assert.equal(
    DeepWaterBriefActionJobPayloadSchema.safeParse(
      payload('requester', { kind: 'reply', message: 'hi', settings: { depth: 'light' } }),
    ).success,
    false,
  )
  assert.equal(
    DeepWaterBriefActionJobPayloadSchema.safeParse(
      payload('requester', { kind: 'launch', revision: 2, public: false }),
    ).success,
    true,
  )
  // The retry window runs from when the action was accepted, so a job carries it.
  const undated: Record<string, unknown> = payload('owner', { kind: 'cancel' })
  delete undated.acceptedAt
  assert.equal(DeepWaterBriefActionJobPayloadSchema.safeParse(undated).success, false)
})

test('a reply job carries base_revision exactly when it edits, as Ledger requires', () => {
  const payload = (action: Record<string, unknown>) => ({
    organizationId: RUN_ID,
    runId: RUN_ID,
    actionId: ACTION_ID,
    acceptedAt: '2026-09-23T09:00:00.000Z',
    actor: {
      userId: USER_ID,
      role: 'requester',
      identity: { subject: 'uoa|1', organizationId: 'o', teamId: 't', tokenVersion: 0 },
    },
    action,
  })
  const parses = (action: Record<string, unknown>) =>
    DeepWaterBriefActionJobPayloadSchema.safeParse(payload({ kind: 'reply', message: 'hi', ...action })).success
  assert.equal(parses({}), true)
  assert.equal(parses({ baseRevision: 3, pillars: ['Costs'] }), true)
  assert.equal(parses({ baseRevision: 3, settings: { depth: null } }), true)
  // Ledger's research_scope_reply refuses both of these.
  assert.equal(parses({ baseRevision: 3 }), false, 'a bare base revision edits nothing')
  assert.equal(parses({ pillars: ['Costs'] }), false, 'an edit names the revision it edited')

  // The request may carry a bare base revision for the API's own check; the job drops it.
  const plain = DeepWaterBriefReplyRequestSchema.parse({ actionId: ACTION_ID, message: 'Focus on the UK', baseRevision: 3 })
  assert.deepEqual(deepWaterReplyAction(plain), { kind: 'reply', message: 'Focus on the UK' })
  assert.equal(parses(deepWaterReplyAction(plain)), true)
  const edited = DeepWaterBriefReplyRequestSchema.parse({
    actionId: ACTION_ID, message: 'Only costs', baseRevision: 3, pillars: ['Costs'],
  })
  assert.deepEqual(deepWaterReplyAction(edited), { kind: 'reply', message: 'Only costs', baseRevision: 3, pillars: ['Costs'] })
  assert.equal(parses(deepWaterReplyAction(edited)), true)
  assert.throws(() => deepWaterReplyAction({ message: 'Only costs', pillars: ['Costs'] }), /carries the revision/)
})

test('product runs know the brief statuses', () => {
  assert.equal(ProductIntegrationRunStatusSchema.parse('drafting'), 'drafting')
  assert.equal(ProductIntegrationRunStatusSchema.parse('cancelled'), 'cancelled')
})
