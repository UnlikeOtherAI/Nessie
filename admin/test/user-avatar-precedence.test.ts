import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { resolveAvatarSource, uoaAvatarPath } from '../src/components/shared/UserAvatar.js'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('the UnlikeOtherAI picture outranks a local upload and the provider picture', () => {
  assert.equal(
    resolveAvatarSource(
      { avatarUrl: 'https://google.test/picture.png' },
      { customUrl: 'blob:local-upload', uoaUrl: 'blob:uoa-relay' },
    ),
    'blob:uoa-relay',
  )
})

test('a local upload is used only where UnlikeOtherAI has nothing', () => {
  // The relay 404s for an unlinked user and for a deployment with no UOA at
  // all, which is exactly where the local upload still belongs.
  assert.equal(
    resolveAvatarSource(
      { avatarUrl: 'https://google.test/picture.png' },
      { customUrl: 'blob:local-upload', uoaUrl: null },
    ),
    'blob:local-upload',
  )
})

test('the provider picture is the last image source, then initials', () => {
  assert.equal(
    resolveAvatarSource(
      { avatarUrl: 'https://google.test/picture.png' },
      { customUrl: null, uoaUrl: null },
    ),
    'https://google.test/picture.png',
  )
  assert.equal(resolveAvatarSource({}, { customUrl: null, uoaUrl: null }), null)
})

test('a person named only by UOA subject resolves through the roster relay', () => {
  // A team roster row often has no local user row, so the user-id relay
  // cannot name them; the roster-scoped relay checks the subject against the
  // roster before relaying. A local user id still wins when both are known —
  // both endpoints serve the one picture UOA holds for that person.
  assert.equal(
    uoaAvatarPath({ uoaSub: 'usr_ada' }),
    '/api/team/members/usr_ada/avatar',
  )
  assert.equal(
    uoaAvatarPath({ userId: 'user-1', uoaSub: 'usr_ada' }),
    '/api/users/user-1/avatar',
  )
  assert.equal(uoaAvatarPath({}), null)
  // Subjects are opaque UOA strings, so the path segment is escaped.
  assert.equal(
    uoaAvatarPath({ uoaSub: 'usr/ada?x' }),
    '/api/team/members/usr%2Fada%3Fx/avatar',
  )
})

test('the team roster renders the shared avatar, not a second implementation', () => {
  const roster = readSource('../src/pages/settings/TeamMemberPeople.tsx')

  assert.match(roster, /<UserAvatar/)
  assert.match(roster, /uoaSub=\{member\.uoaSub\}/)
})

test('Gravatar is gone from the avatar chain and from the API contract', () => {
  const avatar = readSource('../src/components/shared/UserAvatar.tsx')
  assert.equal(/gravatarUrl/.test(avatar), false)

  // Nothing in the admin may re-introduce it: it is derived from the email
  // address (UOA's data) and leaked a hash of every member's address to a third
  // party to render what initials already cover.
  const apiTypes = readSource('../../packages/client-core/src/api-types.ts')
  assert.equal(/gravatarUrl/.test(apiTypes), false)
})

test('the profile panel routes a UOA session to the relay, not the local attachment', () => {
  const panel = readSource('../src/components/features/settings/AvatarPanel.tsx')

  assert.match(panel, /const managedByUoa = me\.auth\.providerType === 'uoa'/)
  assert.match(panel, /await uploadUoaAvatar\.mutateAsync\(file\)/)
  assert.match(panel, /removeUoaAvatar\.mutate\(undefined, \{ onError \}\)/)
  // The local path survives for deployments with no UOA.
  assert.match(panel, /const attachment = await uploadAttachment\(file, token\)/)
  assert.match(panel, /await updateAvatar\.mutateAsync\(attachment\.id\)/)
})
