import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('the shared composer announces a synchronous send failure', () => {
  const composer = readSource('../src/components/features/channels/ChannelComposer.tsx')

  assert.match(
    composer,
    /\{sendError \? \([\s\S]*?role="alert"[\s\S]*?\{sendError\}[\s\S]*?\) : null\}/,
  )
})
