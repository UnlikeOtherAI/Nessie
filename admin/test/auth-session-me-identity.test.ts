import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { MeResponse } from '@nessie/schemas'

import { isSameMeResponse } from '../src/providers/me-response-identity'

const read = (relativePath: string): string =>
  readFileSync(new URL(relativePath, import.meta.url), 'utf8')

// `me` is republished by the /me poll, by every preference PATCH echo and by
// the avatar mutation. Every one of the ~115 `useAuthSession()` readers
// re-renders when its identity changes, and optimistic sidebar state is
// reverted with it, so an unchanged response must not become a new object.
const makeMe = (): MeResponse => JSON.parse(JSON.stringify({
  context: {
    organizationId: '00000000-0000-4000-8000-000000000001',
    projectId: '00000000-0000-4000-8000-000000000002',
    teamId: '00000000-0000-4000-8000-000000000003',
  },
  user: {
    email: 'reader@example.com',
    id: '00000000-0000-4000-8000-000000000004',
    name: 'Reader',
    preferences: {
      focusModeEnabled: false,
      starred: [{ id: '00000000-0000-4000-8000-000000000005', type: 'channel' }],
    },
    roles: ['member'],
  },
})) as MeResponse

test('two structurally equal /me responses are the same response', () => {
  assert.equal(isSameMeResponse(makeMe(), makeMe()), true)
  assert.equal(isSameMeResponse(null, null), true)
})

test('any real change is a change', () => {
  const changedTeam = makeMe()
  changedTeam.context.teamId = '00000000-0000-4000-8000-00000000000f'
  assert.equal(isSameMeResponse(makeMe(), changedTeam), false)

  const changedStar = makeMe()
  const preferences = changedStar.user.preferences as { starred: unknown[] }
  preferences.starred = []
  assert.equal(isSameMeResponse(makeMe(), changedStar), false)

  assert.equal(isSameMeResponse(null, makeMe()), false)
  assert.equal(isSameMeResponse(makeMe(), null), false)
})

test('applyMeResponse bails on an unchanged response', () => {
  const provider = read('../src/providers/AuthSessionProvider.tsx')
  assert.match(provider, /if \(isSameMeResponse\(meRef\.current, nextMe\)\) return/)
})
