import assert from 'node:assert/strict'
import test from 'node:test'

import { DocumentChangedTriggerConfigSchema } from '@nessie/schemas'

import {
  buildDocumentConfig,
  documentPickerOptions,
  getDefaultDocumentState,
  groupDocumentRefusals,
  spaceNarrowerThanChannel,
} from '../src/components/features/triggers/document-trigger-form'
import {
  documentDeliveryLine,
  formatQuietWindow,
  getDocumentTriggerSummary,
} from '../src/components/features/triggers/document-trigger-presentation'
import { getDefaultCreateState, triggerTargetChannels } from '../src/components/features/triggers/trigger-config'
import type { AgentRecord, ChannelRecord } from '../src/lib/api-client'

// The Triggers editor's document_changed half
// (docs/plans/2026-09-23-ticket-driven-agents/triggers.md → "document_changed"):
// what it posts is the typed config the server parses, a refusal lands on the
// field its path names, only a public project channel is offered, and a
// delivery says what it decided in words.

const SPACE = '20000000-0000-4000-8000-000000000001'
const SPECS = '20000000-0000-4000-8000-000000000002'
const API = '20000000-0000-4000-8000-000000000003'
const PLAN = '20000000-0000-4000-8000-000000000004'
const NOTES = '20000000-0000-4000-8000-000000000005'
const SHEET = '20000000-0000-4000-8000-000000000006'

const withInstructions = (state = getDefaultDocumentState({ spaceId: SPACE })) => ({
  ...state,
  instructions: '  Review the change.  ',
})

test('a create posts exactly the typed config the server parses, leaving unset narrowings out', () => {
  const built = buildDocumentConfig(withInstructions())
  assert.ok('config' in built, JSON.stringify(built))
  assert.deepEqual(built.config, {
    spaceId: SPACE,
    kinds: ['document', 'file'],
    fireOn: 'save',
    quietSeconds: 180,
    includeAgentEdits: false,
    instructions: { general: 'Review the change.' },
  })
  const parsed = DocumentChangedTriggerConfigSchema.parse(built.config)
  assert.deepEqual(parsed, built.config, 'nothing is added or dropped by the server parse')

  // The Finder's doorway: one folder, or one page, in its space.
  const folder = buildDocumentConfig(withInstructions(getDefaultDocumentState({ folderPageId: SPECS, spaceId: SPACE })))
  assert.ok('config' in folder)
  assert.equal(DocumentChangedTriggerConfigSchema.parse(folder.config).folderPageId, SPECS)
  const page = buildDocumentConfig({
    ...withInstructions(getDefaultDocumentState({ pageIds: [PLAN], spaceId: SPACE })),
    labels: ['spec', ' Spec ', 'api'],
    kinds: ['document'],
    fireOn: 'publish',
    quietSeconds: '600',
  })
  assert.ok('config' in page)
  assert.deepEqual(DocumentChangedTriggerConfigSchema.parse(page.config), {
    spaceId: SPACE,
    pageIds: [PLAN],
    labels: ['Spec', 'api'],
    kinds: ['document'],
    fireOn: 'publish',
    quietSeconds: 600,
    includeAgentEdits: false,
    instructions: { general: 'Review the change.' },
  })

  // No space chosen: the server resolves the project's Documents space.
  const bare = buildDocumentConfig(withInstructions(getDefaultDocumentState()))
  assert.ok('config' in bare)
  assert.equal('spaceId' in bare.config, false)
})

test('the Finder prefill opens the editor on a document trigger for that folder', () => {
  const state = getDefaultCreateState([], [], [], {
    agentId: 'agent',
    targetKind: 'agent',
    prefill: { document: { folderPageId: SPECS, spaceId: SPACE }, name: 'Review changes in Specs', triggerType: 'document_changed' },
  })
  assert.equal(state.triggerType, 'document_changed')
  assert.equal(state.name, 'Review changes in Specs')
  assert.equal(state.document?.spaceId, SPACE)
  assert.equal(state.document?.folderPageId, SPECS)
  assert.deepEqual(state.document?.pageIds, [])
})

test('the editor refuses what it can see itself, on the field', () => {
  assert.equal((buildDocumentConfig(getDefaultDocumentState({ spaceId: SPACE })) as { field: string }).field, 'instructions')
  assert.equal((buildDocumentConfig({ ...withInstructions(), kinds: [] }) as { field: string }).field, 'kinds')
  for (const quiet of ['9', '3601', '1.5', 'soon', '']) {
    const result = buildDocumentConfig({ ...withInstructions(), quietSeconds: quiet })
    assert.ok('error' in result, quiet)
    assert.equal(result.field, 'quietSeconds', quiet)
  }
  const tooMany = buildDocumentConfig({ ...withInstructions(), pageIds: Array.from({ length: 51 }, () => PLAN) })
  assert.equal((tooMany as { field: string }).field, 'pageIds')
})

test('a server refusal lands on the field its path names', () => {
  const grouped = groupDocumentRefusals({
    refusals: [
      { path: 'spaceId', reason: 'space Leadership is members, narrower than #engineering.' },
      { path: 'pageIds[1]', reason: '"Budget" is not in space Tech docs.' },
      { path: 'instructions.general', reason: 'say what the agent does.' },
      { path: 'targetChannelId', reason: '#leads is protected.' },
      { path: 'config', reason: 'unrecognized key "watch".' },
    ],
  })
  assert.deepEqual(grouped.fields, {
    instructions: 'say what the agent does.',
    pageIds: '"Budget" is not in space Tech docs.',
    spaceId: 'space Leadership is members, narrower than #engineering.',
    targetChannelId: '#leads is protected.',
  })
  assert.deepEqual(grouped.rest, ['config: unrecognized key "watch".'])
})

test('only the agent’s live, ordinary, public project channels are offered for document or ticket work', () => {
  const room = (id: string, extra: Partial<ChannelRecord> = {}) => ({
    archivedAt: null, id, label: id, scope: 'project', type: 'standard', visibility: 'public', ...extra,
  }) as ChannelRecord
  const channels = [
    room('leads', { visibility: 'protected' }),
    room('engineering'),
    room('elsewhere'),
    room('dm', { type: 'dm' }),
  ]
  const agent = { channelIds: ['leads', 'engineering', 'dm'] } as AgentRecord
  const ids = (type: Parameters<typeof triggerTargetChannels>[2]) =>
    triggerTargetChannels(channels, agent, type).map((channel) => channel.id)
  assert.deepEqual(ids('document_changed'), ['engineering'])
  assert.deepEqual(ids('ticket_changed'), ['engineering'])
  assert.deepEqual(ids('webhook'), ['leads', 'engineering', 'dm'], 'other types keep every bound room')
})

test('the pickers offer the space’s folders by path, and pages inside the chosen folder of the watched kinds', () => {
  const page = (id: string, title: string, kind: string, parentPageId: string | null, labels: string[] = []) =>
    ({ id, kind, labels, parentPageId, spaceId: SPACE, title }) as never
  const pages = [
    page(SPECS, 'Specs', 'folder', null),
    page(API, 'API', 'folder', SPECS),
    page(PLAN, 'Plan', 'document', API, ['spec']),
    page(NOTES, 'Notes.md', 'file', null, ['meeting']),
    page(SHEET, 'Budget', 'spreadsheet', SPECS),
    { ...page('20000000-0000-4000-8000-000000000009', 'Elsewhere', 'document', null), spaceId: 'other' } as never,
  ]
  const all = documentPickerOptions(pages, { folderPageId: '', kinds: ['document', 'file'], spaceId: SPACE })
  assert.deepEqual(all.folders, [{ id: SPECS, label: 'Specs' }, { id: API, label: 'Specs / API' }])
  assert.deepEqual(all.pages, [{ id: NOTES, label: 'Notes.md' }, { id: PLAN, label: 'Specs / API / Plan' }])
  assert.deepEqual(all.labels, ['meeting', 'spec'])
  const inSpecs = documentPickerOptions(pages, { folderPageId: SPECS, kinds: ['document', 'file'], spaceId: SPACE })
  assert.deepEqual(inSpecs.pages.map((option) => option.id), [PLAN], 'a page outside the folder would never fire')
  const filesOnly = documentPickerOptions(pages, { folderPageId: '', kinds: ['file'], spaceId: SPACE })
  assert.deepEqual(filesOnly.pages.map((option) => option.id), [NOTES])
})

test('only a project- or organisation-wide shared space can be watched from a public channel', () => {
  const space = (extra: Record<string, unknown>) => ({
    ownerAgentId: null, privateToAgentId: null, sensitivityTier: 'normal', visibility: 'project', ...extra,
  }) as never
  assert.equal(spaceNarrowerThanChannel(space({})), null)
  assert.equal(spaceNarrowerThanChannel(space({ visibility: 'organization' })), null)
  assert.match(spaceNarrowerThanChannel(space({ visibility: 'team' })) ?? '', /team only/)
  assert.match(spaceNarrowerThanChannel(space({ sensitivityTier: 'restricted' })) ?? '', /restricted/)
  assert.match(spaceNarrowerThanChannel(space({ ownerAgentId: 'agent' })) ?? '', /agent’s own/)
})

test('a document trigger reads as what it watches, and each delivery says what it decided', () => {
  assert.equal(formatQuietWindow(45), '45 s')
  assert.equal(formatQuietWindow(180), '3 min')
  assert.equal(formatQuietWindow(5400), '1 h 30 min')
  assert.equal(
    getDocumentTriggerSummary({
      spaceId: SPACE, folderPageId: SPECS, kinds: ['document', 'file'], fireOn: 'save', quietSeconds: 180,
    }),
    'Reviews each save of a folder’s documents and files, after 3 min quiet',
  )
  assert.equal(
    getDocumentTriggerSummary({ spaceId: SPACE, pageIds: [PLAN], labels: ['spec'], fireOn: 'publish', quietSeconds: 60 }),
    'Reviews each publish of 1 chosen page labelled spec, after 1 min quiet',
  )
  assert.equal(getDocumentTriggerSummary({}), 'Configuration needs attention')

  const base = {
    pageId: PLAN, spaceId: SPACE, projectId: SPECS, taskId: null, kind: 'document', fireOn: 'save',
    fromVersionId: API, fromVersionNumber: 4, toVersionId: NOTES, toVersionNumber: 6, versionsCoalesced: 2,
    authorKinds: ['person'], bodyChars: 1200,
  }
  assert.equal(
    documentDeliveryLine({ ...base, outcome: 'page_thread', threadId: SHEET }),
    'Woke the agent to review v4 → v6 (2 saves) in the document’s thread.',
  )
  assert.equal(
    documentDeliveryLine({ ...base, outcome: 'ticket_work', workId: SHEET, threadId: SHEET, versionsCoalesced: 1 }),
    'Woke the ticket’s work to review v4 → v6.',
  )
  assert.match(
    documentDeliveryLine({ ...base, authorKinds: [], outcome: 'skipped', skipReason: 'agent_edits_only' }) ?? '',
    /^Only agents saved this document — .* so nobody was woken\.$/,
  )
  assert.equal(documentDeliveryLine({ prompt: 'webhook payload' }), null, 'any other trigger keeps its raw payload')
})
