import assert from 'node:assert/strict'
import test from 'node:test'

import { DEEP_WATER_DEFAULT_BRIEF_SETTINGS, type DeepWaterBriefSettings } from '@nessie/schemas'

import {
  NO_EDITS,
  editsPayload,
  effectiveBrief,
  hasLocalEdits,
  payloadHasEdits,
  pillarCountForStart,
  pillarsProblem,
  rebaseEdits,
  reviveBriefEdits,
  withPillarsEdit,
  withSettingEdit,
} from '../src/components/features/deep-water/brief-edits.js'

/**
 * A person's unsent changes to a brief (amendments-fable F8, contract D4 and
 * §3 "Rules for edits and locks"). Every setting key sent to DeepWater becomes
 * a lock against its planner, so the dialog must send only what the person
 * actually changed, and must carry their edits over a brief that moved on.
 */

const settings = (overrides: Partial<DeepWaterBriefSettings> = {}): DeepWaterBriefSettings => ({
  ...DEEP_WATER_DEFAULT_BRIEF_SETTINGS,
  ...overrides,
})

const brief = {
  lockedSettings: ['outputLanguage' as const],
  pillars: ['Costs', 'Performance'],
  settings: settings({ depth: 'deep', outputLanguage: 'cs' }),
}

test('with no edits the person sees DeepWater\'s brief, its locks and nothing to send', () => {
  const effective = effectiveBrief(brief, NO_EDITS)
  assert.deepEqual(effective.pillars, ['Costs', 'Performance'])
  assert.equal(effective.pillarsEdited, false)
  assert.deepEqual([...effective.locked], ['outputLanguage'])
  assert.equal(effective.editedKeys.size, 0)
  assert.deepEqual(editsPayload(brief, NO_EDITS), {})
  assert.equal(payloadHasEdits(editsPayload(brief, NO_EDITS)), false)
  assert.equal(hasLocalEdits(NO_EDITS), false)
})

test('a brief with no settings yet shows DeepWater\'s defaults', () => {
  const effective = effectiveBrief({ lockedSettings: [], pillars: [], settings: null }, NO_EDITS)
  assert.deepEqual(effective.settings, DEEP_WATER_DEFAULT_BRIEF_SETTINGS)
})

test('choosing a value locks it, and only the changed key is sent', () => {
  const edits = withSettingEdit(brief, NO_EDITS, 'recency', 'year')
  const effective = effectiveBrief(brief, edits)
  assert.equal(effective.settings.recency, 'year')
  assert.ok(effective.locked.has('recency'))
  assert.ok(effective.editedKeys.has('recency'))
  assert.deepEqual(editsPayload(brief, edits), { settings: { recency: 'year' } })
})

test('picking the value DeepWater already chose is no choice at all, so nothing gets locked', () => {
  const edits = withSettingEdit(brief, NO_EDITS, 'depth', 'deep')
  assert.deepEqual(edits, NO_EDITS)
  assert.deepEqual(editsPayload(brief, edits), {})
})

test('handing a locked setting back to DeepWater sends null, which clears the lock', () => {
  const edits = withSettingEdit(brief, NO_EDITS, 'outputLanguage', null)
  const effective = effectiveBrief(brief, edits)
  assert.equal(effective.locked.has('outputLanguage'), false)
  assert.deepEqual(editsPayload(brief, edits), { settings: { outputLanguage: null } })
})

test('releasing a setting DeepWater already decides is not an edit', () => {
  assert.deepEqual(withSettingEdit(brief, NO_EDITS, 'recency', null), NO_EDITS)
})

test('re-choosing the value a locked setting holds is kept as a lock, and sends nothing new', () => {
  // The key is locked at `cs`: the person choosing `cs` again changes nothing.
  const edits = withSettingEdit(brief, NO_EDITS, 'outputLanguage', 'cs')
  assert.deepEqual(editsPayload(brief, edits), {})
})

test('pillars ride as a whole new list, cleaned of blank rows, only when they changed', () => {
  const edits = withPillarsEdit(brief, NO_EDITS, ['Costs', '  ', ' Grants '])
  assert.equal(effectiveBrief(brief, edits).pillarsEdited, true)
  assert.deepEqual(editsPayload(brief, edits), { pillars: ['Costs', 'Grants'] })
  assert.deepEqual(withPillarsEdit(brief, edits, ['Costs', 'Performance']), NO_EDITS)
})

test('Start counts the person\'s own pillars, so hand-written pillars can launch', () => {
  assert.equal(pillarCountForStart(brief, NO_EDITS), 2)
  assert.equal(pillarCountForStart({ ...brief, pillars: [] }, { pillars: ['One', ''] }), 1)
  assert.equal(pillarCountForStart(brief, { pillars: ['', ' '] }), 0)
})

test('pillars are checked against the contract before they are sent', () => {
  assert.equal(pillarsProblem(['', ' ']), 'Add at least one pillar.')
  assert.equal(pillarsProblem(Array.from({ length: 61 }, (_, index) => `P${index}`)), 'A brief can have at most 60 pillars.')
  assert.equal(pillarsProblem(['x'.repeat(501)]), 'Keep each pillar under 500 characters.')
  assert.equal(pillarsProblem(['Costs', '']), null)
})

test('a brief that moved on keeps the person\'s edits on top and says what DeepWater changed', () => {
  const edits = withSettingEdit(brief, withPillarsEdit(brief, NO_EDITS, ['Costs', 'Grants']), 'recency', 'year')
  const next = {
    lockedSettings: ['outputLanguage' as const],
    pillars: ['Costs', 'Performance', 'Installers'],
    settings: settings({ depth: 'heavy', outputLanguage: 'cs' }),
  }
  const rebase = rebaseEdits(brief, next, edits)
  assert.deepEqual(rebase.changed, ['the pillars', 'how thorough'])
  assert.deepEqual(rebase.edits, { pillars: ['Costs', 'Grants'], settings: { recency: 'year' } })
})

test('an edit the new brief already matches is dropped in the rebase', () => {
  const edits = withSettingEdit(brief, NO_EDITS, 'recency', 'year')
  const next = { ...brief, lockedSettings: [...brief.lockedSettings, 'recency' as const],
    settings: settings({ depth: 'deep', outputLanguage: 'cs', recency: 'year' }) }
  const rebase = rebaseEdits(brief, next, edits)
  assert.deepEqual(rebase.edits, {})
  assert.deepEqual(rebase.changed, ['sources from'])
})

test('a stored draft is untrusted: unknown keys and stale values are dropped', () => {
  assert.deepEqual(reviveBriefEdits(null), NO_EDITS)
  assert.deepEqual(reviveBriefEdits('nope'), NO_EDITS)
  assert.deepEqual(
    reviveBriefEdits({
      pillars: ['A', 3],
      settings: { depth: 'thesis', recency: 'week', title: 'x', outputLanguage: null },
    }),
    { settings: { outputLanguage: null, recency: 'week' } },
  )
  assert.deepEqual(reviveBriefEdits({ pillars: ['A', 'B'] }), { pillars: ['A', 'B'] })
})
