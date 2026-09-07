import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const readSource = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

test('watcher recipient choices close their popover before the save action', () => {
  const recipientBar = readSource('../src/components/shared/RecipientBar.tsx')
  const watchers = readSource('../src/pages/project/settings/BoardWatchersEditor.tsx')

  assert.match(recipientBar, /closeAfterSelection = false/)
  assert.match(recipientBar, /if \(closeAfterSelection\) \{\s*setFocused\(false\)/)
  assert.match(watchers, /<RecipientBar[\s\S]*closeAfterSelection/)
})
