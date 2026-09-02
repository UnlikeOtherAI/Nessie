import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { matchSurface, surfaceParent } from '../src/navigation/surfaces'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

const workspace = readSource('../src/components/features/knowledge/KnowledgeWorkspace.tsx')

// Knowledge's inner screens are nested stages (docs/navigation.md §6): the
// stack owns their layers, and each registers its own Back through
// NestedStage. The workspace itself registers nothing.

test('each knowledge screen is a nested stage with its pinned id and priority', () => {
  const stages = [
    ['knowledge:folder', 'knowledgeFolder', 'Back to parent folder'],
    ['knowledge:document', 'knowledgeDocument', "depth > 0 ? 'Back to parent page' : 'Back to space'"],
    ['knowledge:history', 'knowledgeHistory', 'Back from version history'],
    ['knowledge:editor', 'knowledgeEditor', 'Back from page editor'],
  ] as const

  let cursor = -1
  for (const [id, priority, label] of stages) {
    const at = workspace.indexOf(`id="${id}"`)
    assert.ok(at > cursor, `stage ${id} missing or out of ladder order`)
    cursor = at
    // Its own label and priority sit on the same element.
    const element = workspace.slice(
      workspace.lastIndexOf('<NestedStage', at),
      workspace.indexOf('</NestedStage>', at),
    )
    assert.ok(
      element.includes(`LOCAL_BACK_PRIORITY.${priority}`),
      `${id} must register LOCAL_BACK_PRIORITY.${priority}`,
    )
    assert.ok(element.includes(label), `${id} must keep its label ${label}`)
  }
})

test('the workspace registers no Back owner of its own — the stages do', () => {
  assert.doesNotMatch(workspace, /useLocalBack/)
  assert.match(workspace, /import \{ NestedStage, useNestedStageHosted \}/)

  // NestedStage is what registers, and only where a stack hosts the stage.
  const stage = readSource('../src/navigation/NestedStage.tsx')
  assert.match(stage, /active: active && hosted/)
  assert.match(stage, /id: `stage:\$\{id\}`/)
})

test('every stage unwinds exactly one level, deepest first', () => {
  const actions = [
    'onBack={() => browseTo(pathPages.slice(0, -1).map((page) => page.id))}',
    'onBack={() => popTo(depth)}',
    'onBack={closeHistory}',
    'onBack={closeEditor}',
  ]
  let cursor = -1
  for (const action of actions) {
    const at = workspace.indexOf(action)
    assert.ok(at > cursor, `unwind order broken at ${action}`)
    cursor = at
  }
})

test('the editor refuses the edge swipe while it is open', () => {
  // The page editor keeps its draft in its own state and publishes no dirty
  // signal, so the gesture stays refused for as long as it is open.
  const editorStage = workspace.slice(workspace.indexOf('id="knowledge:editor"'))
  assert.match(editorStage.slice(0, editorStage.indexOf('>')), /swipeable=\{false\}/)
  assert.equal((workspace.match(/swipeable=\{false\}/g) ?? []).length, 1)
})

test('inner knowledge surfaces keep titles/actions but suppress their own Back in the stack', () => {
  // Every onBack the workspace hands to an inner pane is gated on the stack
  // hosting the stage; there the shared doorway renders the stage's own Back.
  const handoffs = workspace.match(/onBack=\{stacked \? undefined :/g) ?? []
  assert.ok(handoffs.length >= 2, `expected pane handoffs stack-gated, found ${handoffs.length}`)
  const documentPane = readSource('../src/components/features/knowledge/KnowledgeDocumentPane.tsx')
  assert.match(documentPane, /onBack\?: \(\) => void/)

  const pane = readSource('../src/components/features/knowledge/KnowledgePane.tsx')
  assert.match(pane, /onBack\?: \(\) => void/)

  for (const path of [
    '../src/components/features/knowledge/PagePreview.tsx',
    '../src/components/features/knowledge/FileNodeViewer.tsx',
  ]) {
    assert.match(readSource(path), /onBack\?: \(\) => void/, path)
  }
})

test('an inline host still composes one knowledge pane at a time', () => {
  // On split the stages render where they stand, so the base browser yields to
  // whichever pane is deepest — the composition the early returns used to give.
  assert.match(workspace, /const historyOpen = Boolean\(historyPage\) && \(stacked \|\| !editorOpen\)/)
  assert.match(
    workspace,
    /const documentOpen = Boolean\(current\) && \(stacked \|\| !\(editorOpen \|\| historyOpen\)\)/,
  )
  assert.match(
    workspace,
    /const baseIsBrowser = stacked \|\| !\(editorOpen \|\| historyOpen \|\| documentOpen\)/,
  )
  // A folder is only ever a layer; inline, the browser already renders the path.
  assert.match(workspace, /const folderOpen = stacked && !current/)
})

test('the agent detail page owns no Back of its own', () => {
  // `/agents/:id` is a real depth-2 route (parent Agents), so the shared route
  // Back returns there. Its old registration outranked the knowledge stages
  // inside the Documents tab and left the agent instead of unwinding.
  const page = readSource('../src/pages/AgentDetailPage.tsx')
  assert.doesNotMatch(page, /useLocalBack/)
  assert.doesNotMatch(page, /LOCAL_BACK_PRIORITY/)
  // Wider layouts keep their own Back button beside the title.
  assert.match(page, /!phoneLayout \? \(/)

  assert.equal(matchSurface('/agents/agent_a')?.surface.depth, 2)
  assert.deepEqual(surfaceParent('/agents/agent_a'), {
    label: 'Back to Agents',
    pathname: '/agents',
  })
})
