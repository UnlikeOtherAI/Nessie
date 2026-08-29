import assert from 'node:assert/strict'
import test from 'node:test'

import { TABS, tabIndexForPath } from './tabs'

const indexOfKey = (key: string): number => TABS.findIndex((tab) => tab.key === key)

test('tabIndexForPath maps each section root to its own tab', () => {
  assert.equal(tabIndexForPath('/channels'), indexOfKey('channels'))
  assert.equal(tabIndexForPath('/projects'), indexOfKey('projects'))
  assert.equal(tabIndexForPath('/knowledge-base'), indexOfKey('knowledge'))
  assert.equal(tabIndexForPath('/settings'), indexOfKey('admin'))
  assert.equal(tabIndexForPath('/search'), indexOfKey('search'))
})

test('tabIndexForPath keeps Admin active across the whole admin route family', () => {
  const admin = indexOfKey('admin')
  for (const path of ['/agents', '/workflows', '/apps', '/mcp-app-store', '/approvals', '/audit', '/tokens', '/policy', '/ops']) {
    assert.equal(tabIndexForPath(path), admin, path)
    assert.equal(tabIndexForPath(`${path}/nested/detail`), admin, `${path}/nested/detail`)
  }
})

// Regression: the admin bridge reports `${pathname}${search}`, and a WebView
// reload (boot recovery `?__boot=N`, billing return `?uoa_billing=...`) reaches
// the native tab bar as `/settings?__boot=1`. Matching the raw string missed the
// prefix and fell back to Channels while the admin rendered the Admin page.
test('tabIndexForPath ignores query and hash so a reloaded route keeps its tab', () => {
  const admin = indexOfKey('admin')
  assert.equal(tabIndexForPath('/settings?__boot=1'), admin)
  assert.equal(tabIndexForPath('/tokens?uoa_billing=checkout_complete'), admin)
  assert.equal(tabIndexForPath('/agents/designer?parentId=x#tab'), admin)
  assert.equal(tabIndexForPath('/channels?filter=unread'), indexOfKey('channels'))
  assert.equal(tabIndexForPath('/dashboards/abc?range=7d'), indexOfKey('knowledge'))
})

test('tabIndexForPath ignores a trailing slash', () => {
  assert.equal(tabIndexForPath('/settings/'), indexOfKey('admin'))
  assert.equal(tabIndexForPath('/channels/'), indexOfKey('channels'))
})

test('tabIndexForPath falls back to Channels for an unowned route', () => {
  assert.equal(tabIndexForPath('/'), 0)
  assert.equal(tabIndexForPath('/login'), 0)
})
