import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectAvatarSource = readFileSync(
  fileURLToPath(new URL('../src/components/primitives/ProjectAvatar.tsx', import.meta.url)),
  'utf8',
)

test('project emojis use no avatar background and unset pictures fall back to the folder glyph', () => {
  assert.doesNotMatch(projectAvatarSource, /bg-\[color:var\(--accent\)\]/)
  assert.match(projectAvatarSource, /avatarEmoji \? \(/)
  assert.match(projectAvatarSource, /M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8/)
})
