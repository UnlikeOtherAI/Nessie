import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('pending agent invite actions use the shared button shape', () => {
  const composer = readSource('../src/components/features/channels/ChannelComposer.tsx')

  assert.match(
    composer,
    /className="admin-button admin-button-primary"[\s\S]*?Invite & reply/,
  )
  assert.match(
    composer,
    /className="admin-button admin-button-secondary"[\s\S]*?Dismiss/,
  )
})
