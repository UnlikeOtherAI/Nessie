import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DocumentChangedStoredConfigSchema,
  DocumentTriggerDeliveryPayloadSchema,
  documentTriggerDeliveryKey,
  documentTriggerDeliveryKeyPrefix,
  documentTriggerPendingKey,
  documentTriggerWatchesPage,
  DOCUMENT_TRIGGER_SKIP_SENTENCES,
  DocumentTriggerSkipReasonSchema,
} from '../document-triggers.js'
import { AgentTriggerConfigInputSchema, describeAgentTriggerType, DocumentChangedTriggerConfigSchema } from '../trigger-configs.js'

const SPACE = '0b6f1c2a-3d4e-4f50-8a61-72839a4b5c6d'
const FOLDER = '1c7f2d3b-4e5f-4061-9b72-8394ab5c6d7e'
const PAGE = '2d8f3e4c-5f60-4172-8c83-94a5bc6d7e8f'
const OTHER = '3e9a4f5d-6a71-4283-9d94-a5b6cd7e8f90'
const minimal = { instructions: { general: 'Review the edit.' } }

test('a document_changed config with only its instructions takes every default', () => {
  const parsed = DocumentChangedTriggerConfigSchema.parse(minimal)
  assert.deepEqual(parsed.kinds, ['document', 'file'])
  assert.equal(parsed.fireOn, 'save')
  assert.equal(parsed.quietSeconds, 180)
  assert.equal(parsed.includeAgentEdits, false)
  assert.equal(parsed.spaceId, undefined)
})

test('the config refuses what nothing reads, a spreadsheet, and a window out of range', () => {
  const refused = (config: Record<string, unknown>): string[] => {
    const result = DocumentChangedTriggerConfigSchema.safeParse(config)
    assert.equal(result.success, false, JSON.stringify(config))
    return result.error!.issues.map((issue) => issue.path.join('.'))
  }
  assert.deepEqual(refused({}), ['instructions'])
  assert.deepEqual(refused({ ...minimal, kinds: ['spreadsheet'] }), ['kinds.0'])
  assert.deepEqual(refused({ ...minimal, kinds: [] }), ['kinds'])
  assert.deepEqual(refused({ ...minimal, quietSeconds: 5 }), ['quietSeconds'])
  assert.deepEqual(refused({ ...minimal, quietSeconds: 3_601 }), ['quietSeconds'])
  assert.deepEqual(refused({ ...minimal, fireOn: 'type' }), ['fireOn'])
  assert.deepEqual(refused({ ...minimal, watchEverything: true }), [''])
  // The union arm needs its target channel beside the config.
  const arm = { config: minimal, type: 'document_changed' }
  assert.equal(AgentTriggerConfigInputSchema.safeParse(arm).success, false)
  assert.equal(AgentTriggerConfigInputSchema.safeParse({ ...arm, targetChannelId: PAGE }).success, true)
})

test('the prose says what it does and names every field', () => {
  const text = describeAgentTriggerType('document_changed').join('\n')
  assert.match(text, /^- document_changed — Wakes the agent when a watched document/)
  assert.match(text, /- targetChannelId: id — A live, ordinary, public channel/)
  assert.match(text, /- fireOn \(optional\): save \| publish, default "save"/)
  assert.match(text, /- quietSeconds \(optional\): whole number 10–3600, default 180/)
  assert.match(text, /- includeAgentEdits \(optional\): true or false, default false/)
})

test('a page is watched only inside the space, the kind, the folder, the pages and the labels named', () => {
  const config = DocumentChangedStoredConfigSchema.parse({ spaceId: SPACE })
  const page = { spaceId: SPACE, kind: 'document', pageId: PAGE, ancestorIds: [FOLDER], labels: ['Spec'] }
  assert.equal(documentTriggerWatchesPage(config, page), true)
  assert.equal(documentTriggerWatchesPage(config, { ...page, spaceId: OTHER }), false)
  assert.equal(documentTriggerWatchesPage(config, { ...page, kind: 'spreadsheet' }), false)
  assert.equal(documentTriggerWatchesPage(config, { ...page, kind: 'folder' }), false)
  assert.equal(documentTriggerWatchesPage({ ...config, folderPageId: FOLDER }, page), true)
  assert.equal(documentTriggerWatchesPage({ ...config, folderPageId: FOLDER }, { ...page, ancestorIds: [] }), false)
  assert.equal(documentTriggerWatchesPage({ ...config, pageIds: [OTHER] }, page), false)
  assert.equal(documentTriggerWatchesPage({ ...config, labels: ['spec'] }, page), true)
  assert.equal(documentTriggerWatchesPage({ ...config, labels: ['design'] }, page), false)
})

test('keys: one pending job per window, one delivery per version, the marker found by prefix', () => {
  assert.equal(documentTriggerPendingKey(FOLDER, PAGE), `doc:${FOLDER}:${PAGE}:pending`)
  assert.equal(documentTriggerDeliveryKey(FOLDER, PAGE, OTHER), `doc:${FOLDER}:${PAGE}:${OTHER}`)
  assert.ok(documentTriggerDeliveryKey(FOLDER, PAGE, OTHER).startsWith(documentTriggerDeliveryKeyPrefix(FOLDER, PAGE)))
})

test('a delivery payload is metadata only, and a skip says why', () => {
  const base = {
    pageId: PAGE, spaceId: SPACE, projectId: FOLDER, taskId: null, kind: 'document', fireOn: 'save',
    fromVersionId: null, fromVersionNumber: null, toVersionId: OTHER, toVersionNumber: 3,
    versionsCoalesced: 3, authorKinds: ['person'], bodyChars: 120,
  }
  assert.equal(DocumentTriggerDeliveryPayloadSchema.safeParse({ ...base, outcome: 'page_thread', threadId: PAGE }).success, true)
  assert.equal(DocumentTriggerDeliveryPayloadSchema.safeParse({ ...base, outcome: 'skipped' }).success, false)
  assert.equal(
    DocumentTriggerDeliveryPayloadSchema.safeParse({ ...base, outcome: 'skipped', skipReason: 'agent_edits_only' }).success,
    true,
  )
  // Nothing of the document travels: a title or a body is refused outright.
  assert.equal(DocumentTriggerDeliveryPayloadSchema.safeParse({ ...base, outcome: 'page_thread', title: 'Spec' }).success, false)
  for (const reason of DocumentTriggerSkipReasonSchema.options) {
    assert.ok(DOCUMENT_TRIGGER_SKIP_SENTENCES[reason].length > 0, reason)
  }
})
