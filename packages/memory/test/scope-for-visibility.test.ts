import assert from 'node:assert/strict'
import { test } from 'node:test'

import { scopeForVisibility } from '../src/scopes.js'

const CHAIN = {
  channelId: 'channel-1',
  organizationId: 'org-1',
  projectId: 'project-1',
  teamId: 'team-1',
  userId: 'user-1',
}

test('each visibility resolves to the id at its own level, not the nearest one', () => {
  assert.deepEqual(scopeForVisibility({ ...CHAIN, visibility: 'private' }), {
    scopeId: 'user-1',
    scopeType: 'user',
  })
  assert.deepEqual(scopeForVisibility({ ...CHAIN, visibility: 'channel' }), {
    scopeId: 'channel-1',
    scopeType: 'channel',
  })
  assert.deepEqual(scopeForVisibility({ ...CHAIN, visibility: 'team' }), {
    scopeId: 'team-1',
    scopeType: 'team',
  })
  assert.deepEqual(scopeForVisibility({ ...CHAIN, visibility: 'project' }), {
    scopeId: 'project-1',
    scopeType: 'project',
  })
  assert.deepEqual(scopeForVisibility({ ...CHAIN, visibility: 'organization' }), {
    scopeId: 'org-1',
    scopeType: 'organization',
  })
})

test('a record with no id at its own visibility level yields no scope', () => {
  // There is no audience to be outside of, so it cannot privilege a reply. It
  // must not silently fall back to a wider level — that would claim a record is
  // scoped to the whole project when nothing said so.
  assert.equal(
    scopeForVisibility({ organizationId: 'org-1', projectId: 'p', userId: null, visibility: 'private' }),
    null,
  )
  assert.equal(
    scopeForVisibility({ channelId: null, organizationId: 'org-1', projectId: 'p', visibility: 'channel' }),
    null,
  )
  assert.equal(
    scopeForVisibility({ organizationId: 'org-1', projectId: 'p', teamId: null, visibility: 'team' }),
    null,
  )
})

test('organization visibility always resolves, since the chain always names one', () => {
  assert.deepEqual(
    scopeForVisibility({ organizationId: 'org-2', projectId: 'p', visibility: 'organization' }),
    { scopeId: 'org-2', scopeType: 'organization' },
  )
})

test('an unrecognised visibility yields no scope rather than a guess', () => {
  assert.equal(scopeForVisibility({ ...CHAIN, visibility: 'something-new' }), null)
})
