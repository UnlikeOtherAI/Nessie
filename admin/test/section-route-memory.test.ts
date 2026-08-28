import assert from 'node:assert/strict'
import test from 'node:test'

import {
  __resetSectionRouteMemory,
  getSectionRoute,
  recordSectionRoute,
  resolveSectionNavTarget,
} from '../src/layouts/admin-shell/section-route-memory.js'

test('an unvisited section resolves to its canonical root', () => {
  __resetSectionRouteMemory()
  assert.equal(resolveSectionNavTarget('admin', '/settings'), '/settings')
  assert.equal(getSectionRoute('admin'), undefined)
})

test('a visited admin sub-page is returned to instead of the section root', () => {
  __resetSectionRouteMemory()
  // Standing on the Agents page inside the Admin section...
  recordSectionRoute('/agents', '/agents')
  // ...the Admin tab now returns there rather than to /settings.
  assert.equal(resolveSectionNavTarget('admin', '/settings'), '/agents')
})

test('the full path (query + hash) is preserved so screen state restores', () => {
  __resetSectionRouteMemory()
  recordSectionRoute('/agents/designer', '/agents/designer?parentId=abc')
  assert.equal(
    resolveSectionNavTarget('admin', '/settings'),
    '/agents/designer?parentId=abc',
  )
})

test('each section remembers its own place independently', () => {
  __resetSectionRouteMemory()
  recordSectionRoute('/agents/triggers', '/agents/triggers')
  recordSectionRoute('/channels/c-1', '/channels/c-1')
  recordSectionRoute('/knowledge-base/spaces/s-1', '/knowledge-base/spaces/s-1')

  assert.equal(resolveSectionNavTarget('admin', '/settings'), '/agents/triggers')
  assert.equal(resolveSectionNavTarget('channels', '/channels'), '/channels/c-1')
  assert.equal(
    resolveSectionNavTarget('knowledge', '/knowledge-base'),
    '/knowledge-base/spaces/s-1',
  )
})

test('the latest visit within a section wins', () => {
  __resetSectionRouteMemory()
  recordSectionRoute('/agents', '/agents')
  recordSectionRoute('/agents/tools', '/agents/tools')
  assert.equal(resolveSectionNavTarget('admin', '/settings'), '/agents/tools')
})

test('a path that belongs to no top-level section is not recorded', () => {
  __resetSectionRouteMemory()
  recordSectionRoute('/login', '/login')
  assert.equal(getSectionRoute('admin'), undefined)
  assert.equal(getSectionRoute('channels'), undefined)
})
