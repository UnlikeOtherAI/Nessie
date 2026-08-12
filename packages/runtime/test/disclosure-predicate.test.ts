import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  isUnrestricted,
  partitionByDisclosure,
  viewerSatisfiesBasis,
  type BasisScopeRow,
  type DisclosureViewer,
} from '../src/disclosure-predicate.js'

const scope = (scopeType: string, scopeId: string): BasisScopeRow => ({ scopeId, scopeType })

const userViewer = (scopes: BasisScopeRow[]): DisclosureViewer => ({
  kind: 'user',
  scopes,
  userId: 'user-1',
})

const AUTONOMOUS: DisclosureViewer = { kind: 'autonomous' }

test('an unstamped message is visible to everyone, including autonomous runs', () => {
  assert.equal(viewerSatisfiesBasis([], userViewer([])), true)
  assert.equal(viewerSatisfiesBasis([], AUTONOMOUS), true)
})

test('a viewer holding every basis scope may read it', () => {
  const basis = [scope('project', 'p1'), scope('team', 't1')]
  const viewer = userViewer([scope('project', 'p1'), scope('team', 't1'), scope('organization', 'o')])

  assert.equal(viewerSatisfiesBasis(basis, viewer), true)
})

test('holding only some basis scopes is not enough — containment, not intersection', () => {
  const basis = [scope('project', 'p1'), scope('team', 't1')]
  const viewer = userViewer([scope('project', 'p1'), scope('organization', 'o')])

  assert.equal(viewerSatisfiesBasis(basis, viewer), false)
})

test('sharing only the organization scope does not admit a restricted message', () => {
  // The regression this predicate exists to prevent: an intersection test would
  // admit every org member, because org is in almost every viewer's scope set.
  const basis = [scope('project', 'private-project')]
  const viewer = userViewer([scope('organization', 'o'), scope('channel', 'c')])

  assert.equal(viewerSatisfiesBasis(basis, viewer), false)
})

test('an autonomous run never reads a restricted message', () => {
  assert.equal(viewerSatisfiesBasis([scope('project', 'p1')], AUTONOMOUS), false)
})

test('a matching id under a different audience type does not satisfy a scope', () => {
  const basis = [scope('project', 'shared-id')]
  const viewer = userViewer([scope('team', 'shared-id')])

  assert.equal(viewerSatisfiesBasis(basis, viewer), false)
})

test('a grant admits a scope the viewer cannot reach by membership', () => {
  const basis = [scope('project', 'p1')]
  const viewer = userViewer([scope('organization', 'o')])

  assert.equal(viewerSatisfiesBasis(basis, viewer), false)
  assert.equal(
    viewerSatisfiesBasis(basis, viewer, new Set(['project:p1'])),
    true,
  )
})

test('a grant covering only one of two basis scopes is still not enough', () => {
  const basis = [scope('project', 'p1'), scope('project', 'p2')]
  const viewer = userViewer([])

  assert.equal(
    viewerSatisfiesBasis(basis, viewer, new Set(['project:p1'])),
    false,
  )
})

test('a grant does not lift restriction for an autonomous run', () => {
  assert.equal(
    viewerSatisfiesBasis([scope('project', 'p1')], AUTONOMOUS, new Set(['project:p1'])),
    false,
  )
})

test('partition keeps withheld messages rather than dropping them', () => {
  const messages = [
    { id: 'a', basisScopes: [] },
    { id: 'b', basisScopes: [scope('project', 'p1')] },
    { id: 'c', basisScopes: null },
  ]

  const { visible, withheld } = partitionByDisclosure(
    messages,
    userViewer([scope('organization', 'o')]),
  )

  assert.deepEqual(visible.map((m) => m.id), ['a', 'c'])
  assert.deepEqual(withheld.map((m) => m.id), ['b'])
})

test('isUnrestricted is the fail-closed form used by search', () => {
  assert.equal(isUnrestricted({ basisScopes: [] }), true)
  assert.equal(isUnrestricted({ basisScopes: null }), true)
  assert.equal(isUnrestricted({}), true)
  assert.equal(isUnrestricted({ basisScopes: [scope('project', 'p1')] }), false)
})
