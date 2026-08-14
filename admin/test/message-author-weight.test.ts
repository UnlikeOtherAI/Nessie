import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('message author names resolve the bold font-weight token', () => {
  const styles = readSource('../src/styles.css')
  const messageRow = readSource('../src/components/features/channels/ChannelMessageRow.tsx')
  const transientRows = readSource('../src/components/features/channels/ChannelTransientMessageRows.tsx')

  assert.match(styles, /--font-weight-bold:\s*700;/)
  assert.match(messageRow, /font-bold text-\[var\(--tx\)\]/)
  assert.match(transientRows, /font-bold text-\[var\(--tx\)\]/)
})
