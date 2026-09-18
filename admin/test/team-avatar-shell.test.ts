import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'


const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('the public UOA directory URL is never given a cache-buster', () => {
  // UOA parses this route's query with `.strict()` and allows only `style` and
  // `size` (UnlikeOtherAuthenticator API/src/routes/avatar/public-team.ts:32,
  // API/src/routes/avatar/shared.ts:14-17). A `v=` buster therefore does not
  // bust the cache — it makes the request throw, and IdentityTile's onError
  // drops the tile to initials. Trading a stale picture for no picture is
  // worse than the defect, so this lane is left to max-age revalidation and
  // the active team is routed through the relay instead.
  const source = readSource('../src/components/primitives/TeamAvatar.tsx')
  assert.ok(
    source.includes('const url = relayedUrl ?? imageUrl ?? null'),
    'the public directory URL must be passed through unchanged',
  )
  assert.ok(
    !/v=\$\{revision\}`\s*$/m.test(source.split('const path =')[0] ?? ''),
    'no cache-buster helper may be applied to the public directory URL',
  )
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
