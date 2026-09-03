import assert from 'node:assert/strict'
import test from 'node:test'
import { nextTransientMenuId } from '../src/layouts/admin-shell/TransientMenuContext'

test('opening a transient menu replaces the previous menu and toggles itself closed', () => {
  assert.equal(nextTransientMenuId(null, 'team'), 'team')
  assert.equal(nextTransientMenuId('team', 'recents'), 'recents')
  assert.equal(nextTransientMenuId('recents', 'account'), 'account')
  assert.equal(nextTransientMenuId('account', 'account'), null)
})
