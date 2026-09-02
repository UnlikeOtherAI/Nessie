import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_TAB_KEY, TABS, tabIndexForSection, type TabKey } from './tabs'

const indexOfKey = (key: string): number => TABS.findIndex((tab) => tab.key === key)

test('tabIndexForSection maps each nessie:screen section to its own tab', () => {
  assert.equal(tabIndexForSection('channels'), indexOfKey('channels'))
  assert.equal(tabIndexForSection('projects'), indexOfKey('projects'))
  assert.equal(tabIndexForSection('knowledge'), indexOfKey('knowledge'))
  assert.equal(tabIndexForSection('admin'), indexOfKey('admin'))
  assert.equal(tabIndexForSection('search'), indexOfKey('search'))
})

// Defensive against a stale or future admin build reporting a section this
// build does not know about — TypeScript's ScreenSection union covers every
// real case, so this exercises the runtime fallback only.
test('tabIndexForSection falls back to Channels for an unrecognized section', () => {
  assert.equal(tabIndexForSection('unknown-section' as unknown as TabKey), 0)
})

test('the cold-start default is the Channels tab, before the first nessie:screen message', () => {
  assert.equal(DEFAULT_TAB_KEY, 'channels')
  assert.equal(tabIndexForSection(DEFAULT_TAB_KEY), indexOfKey('channels'))
})
