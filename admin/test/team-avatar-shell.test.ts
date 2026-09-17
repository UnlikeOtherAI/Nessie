import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { avatarImageUrlWithRevision } from '../src/components/primitives/TeamAvatar.js'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('the cache-busted directory URL keeps its existing query string intact', () => {
  // UOA's directory URL already ends in `?size=128`; a naive
  // `${imageUrl}?v=${revision}` would produce `?size=128?v=1` and bury the
  // size parameter.
  const busted = avatarImageUrlWithRevision(
    'https://authentication.example/teams/uoa-team/avatar?size=128',
    3,
  )
  assert.equal(busted, 'https://authentication.example/teams/uoa-team/avatar?size=128&v=3')
  assert.equal(busted.split('?').length - 1, 1, 'exactly one query-string opener')
  const params = new URL(busted).searchParams
  assert.equal(params.get('size'), '128')
  assert.equal(params.get('v'), '3')
})

test('a directory URL without a query string gets one', () => {
  assert.equal(
    avatarImageUrlWithRevision('https://authentication.example/teams/t/avatar', 2),
    'https://authentication.example/teams/t/avatar?v=2',
  )
})

test('revision zero leaves the directory URL untouched', () => {
  const url = 'https://authentication.example/teams/t/avatar?size=128'
  assert.equal(avatarImageUrlWithRevision(url, 0), url)
})

test('the shell switcher renders the active team through the current-team relay', () => {
  // Passing a teamId for the active team routes through the membership-scoped
  // relay (or skips the relay entirely when avatarTeamId is absent), which is
  // the lane that kept showing the pre-upload picture. The active team must
  // omit teamId so TeamAvatar uses /api/team/avatar — the endpoint the
  // settings panel already proves works.
  const switcher = readSource('../src/layouts/admin-shell/TeamSwitcher.tsx')
  assert.ok(
    !switcher.includes('teamId={active?'),
    'TeamSwitcher must not pass teamId for the active team',
  )
})

test('the team menu keeps the membership-scoped relay only for non-active rows', () => {
  const menu = readSource('../src/layouts/admin-shell/TeamMenu.tsx')
  assert.ok(
    menu.includes('{...(isActive ? {} : { teamId:'),
    'TeamMenu must omit teamId for the active row and keep it for the rest',
  )
})
