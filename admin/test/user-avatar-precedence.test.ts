import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { resolveAvatarSource } from '../src/components/primitives/UserAvatar.js'

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

test('Gravatar is gone from the avatar chain and from the API contract', () => {
  const avatar = readSource('../src/components/primitives/UserAvatar.tsx')
  assert.equal(/gravatarUrl/.test(avatar), false)

  // Nothing in the admin may re-introduce it: it is derived from the email
  // address (UOA's data) and leaked a hash of every member's address to a third
  // party to render what initials already cover.
  const apiTypes = readSource('../../packages/client-core/src/api-types.ts')
  assert.equal(/gravatarUrl/.test(apiTypes), false)
})

test('the profile panel routes a UOA session to the relay, not the local attachment', () => {
  const panel = readSource('../src/pages/settings/profile/AvatarPanel.tsx')

  assert.match(panel, /const managedByUoa = me\.auth\.providerType === 'uoa'/)
  assert.match(panel, /await uploadUoaAvatar\.mutateAsync\(file\)/)
  assert.match(panel, /removeUoaAvatar\.mutate\(undefined, \{ onError \}\)/)
  // The local path survives for deployments with no UOA.
  assert.match(panel, /const attachment = await uploadAttachment\(file, token\)/)
  assert.match(panel, /await updateAvatar\.mutateAsync\(attachment\.id\)/)
})
