import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

const workspace = readSource('../src/components/features/knowledge/KnowledgeWorkspace.tsx')

test('the knowledge workspace unwinds one nested level per Back, deepest first', () => {
  const priorities = [
    ['editor', 'knowledgeEditor'],
    ['historyPageId', 'knowledgeHistory'],
    ['current', 'knowledgeDocument'],
    ['folder', 'knowledgeFolder'],
  ] as const
  let cursor = -1
  for (const [, constant] of priorities) {
    const at = workspace.indexOf(`LOCAL_BACK_PRIORITY.${constant}`)
    assert.ok(at > cursor, `priority ladder order broken at ${constant}`)
    cursor = at
  }

  const actions = ['closeEditor', 'closeHistory', 'popTo(depth)', 'browseTo(']
  cursor = -1
  for (const action of actions) {
    const at = workspace.indexOf(action, workspace.indexOf('const localBackAction'))
    assert.ok(at > cursor, `unwind order broken at ${action}`)
    cursor = at
  }
})

test('inner knowledge surfaces keep titles/actions but suppress their own phone Back', () => {
  // Every onBack the workspace hands to an inner pane is phone-gated; the
  // phone doorway belongs to the outer route header via the registry.
  const handoffs = workspace.match(/onBack=\{phoneLayout \? undefined :/g) ?? []
  assert.ok(handoffs.length >= 5, `expected every pane handoff phone-gated, found ${handoffs.length}`)

  const pane = readSource('../src/components/features/knowledge/KnowledgePane.tsx')
  assert.match(pane, /onBack\?: \(\) => void/)

  for (const path of [
    '../src/components/features/knowledge/PagePreview.tsx',
    '../src/components/features/knowledge/FileNodeViewer.tsx',
  ]) {
    assert.match(readSource(path), /onBack\?: \(\) => void/, path)
  }
})
