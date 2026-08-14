import assert from 'node:assert/strict'
import test from 'node:test'
import { nextTransientMenuId } from '../src/layouts/admin-shell/TransientMenuContext'

test('opening a transient menu replaces the previous menu and toggles itself closed', () => {
  assert.equal(nextTransientMenuId(null, 'workspace'), 'workspace')
  assert.equal(nextTransientMenuId('workspace', 'recents'), 'recents')
  assert.equal(nextTransientMenuId('recents', 'account'), 'account')
  assert.equal(nextTransientMenuId('account', 'account'), null)
})
