import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { surfaceParent } from '../src/navigation/surface-lookup'
import { matchSurface } from '../src/navigation/surfaces'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

const team = readSource('../src/components/features/knowledge/KnowledgeWorkspace.tsx')

// Knowledge's document and editor are nested stages (docs/navigation/overview.md §6).
// History uses Dialog's overlay Back registration.

test('the knowledge document and editor keep their nested stage ids and priorities', () => {
  // `knowledge:folder` is deliberately absent: the Finder sits on
  // `ColumnBrowserViewport`, whose columns are already `column:<k>` stages on
  // `single`, so a folder is a layer without this file owning one.
  const stages = [
    ['knowledge:document', 'knowledgeDocument', 'label={documentBackLabel}'],
    ['knowledge:editor', 'knowledgeEditor', 'Back from page editor'],
  ] as const

  let cursor = -1
  for (const [id, priority, label] of stages) {
    const at = team.indexOf(`id="${id}"`)
    assert.ok(at > cursor, `stage ${id} missing or out of ladder order`)
    cursor = at
    // Its own label and priority sit on the same element.
    const element = team.slice(
      team.lastIndexOf('<NestedStage', at),
      team.indexOf('</NestedStage>', at),
    )
    assert.ok(
      element.includes(`LOCAL_BACK_PRIORITY.${priority}`),
      `${id} must register LOCAL_BACK_PRIORITY.${priority}`,
    )
    assert.ok(element.includes(label), `${id} must keep its label ${label}`)
  }
})

test('knowledge stages and the history dialog own Back through navigation primitives', () => {
  assert.doesNotMatch(team, /useLocalBack/)
  assert.match(team, /<Dialog[\s\S]*title="Version history"/)
  assert.match(team, /\{historyDialog && documentOpen \? historyDialog : null\}/)
  assert.match(team, /\{!documentOpen \? historyDialog : null\}/)
  assert.match(team, /import \{ NestedStage, useNestedStageHosted \}/)

  // NestedStage is what registers, and only where a stack hosts the stage.
  const stage = readSource('../src/navigation/NestedStage.tsx')
  assert.match(stage, /active: active && hosted/)
  assert.match(stage, /id: `stage:\$\{id\}`/)
})

test('each knowledge stage unwinds exactly one level', () => {
  const actions = [
    'onBack={closeDocument}',
    'onBack={closeEditor}',
  ]
  let cursor = -1
  for (const action of actions) {
    const at = team.indexOf(action)
    assert.ok(at > cursor, `unwind order broken at ${action}`)
    cursor = at
  }
})

test('a document inside a folder returns to that folder browser, not folder detail', () => {
  // A path ending in [folder, document] is the browser state while the
  // document stage is open. Back removes only the document, so the Finder can
  // render the same folder column and its retained selection.
  assert.match(
    team,
    /const parentPage = depth > 0 \? pathPages\[depth - 1\] : undefined/,
  )
  assert.match(team, /const closeDocument = parentPage\?\.kind === 'folder'/)
  assert.match(team, /browseTo\(pagePath\.slice\(0, -1\)\)/)
  assert.match(team, /popTo\(depth\)/)
  assert.match(team, /const documentBackLabel = parentPage\?\.kind === 'folder'/)
  assert.match(team, /label=\{documentBackLabel\}/)
})

test('the editor refuses the edge swipe while it is open', () => {
  // The page editor keeps its draft in its own state and publishes no dirty
  // signal, so the gesture stays refused for as long as it is open.
  const editorStage = team.slice(team.indexOf('id="knowledge:editor"'))
  assert.match(editorStage.slice(0, editorStage.indexOf('>')), /swipeable=\{false\}/)
  assert.equal((team.match(/swipeable=\{false\}/g) ?? []).length, 1)
})

test('inner knowledge surfaces render or publish the stage Back from one action', () => {
  // Every onBack the team hands to an inner pane is gated on the stack
  // hosting the stage. `KnowledgePane` then takes the stage's shared Back:
  // native iOS publishes it into the native bar, while web/Android paint it
  // in the pane header instead of relying on the retained route off-screen.
  const handoffs = team.match(/onBack=\{stacked \? undefined :/g) ?? []
  assert.ok(handoffs.length >= 1, `expected pane handoffs stack-gated, found ${handoffs.length}`)
  const documentPane = readSource('../src/components/features/knowledge/KnowledgeDocumentPane.tsx')
  assert.match(documentPane, /onBack\?: \(\) => void/)

  const pane = readSource('../src/components/features/knowledge/KnowledgePane.tsx')
  assert.match(pane, /onBack\?: \(\) => void/)
  assert.match(pane, /leading=\{isStage \? <PhoneNavigationButton \/> : undefined\}/)

  for (const path of [
    '../src/components/features/knowledge/PagePreview.tsx',
    '../src/components/features/knowledge/FileNodeViewer.tsx',
  ]) {
    assert.match(readSource(path), /onBack\?: \(\) => void/, path)
  }
})

test('an inline host delegates document placement to the active Finder view', () => {
  // Tree keeps its hierarchy visible while Columns/List keep the established
  // full-surface detail. History remains an overlay over either Finder view.
  assert.match(
    team,
    /const documentOpen = Boolean\(current\) && \(stacked \|\| !editorOpen\)/,
  )
  assert.match(
    team,
    /const browserVisible = stacked \|\| !editorOpen/,
  )
  assert.match(team, /documentPane=\{!stacked && documentOpen \? documentPane : undefined\}/)
  assert.match(team, /<div className="relative h-full min-h-0 w-full">\{browser\}<\/div>/)
  assert.doesNotMatch(team, /browserCovered/)
  // The old preview column is gone, not restyled.
  assert.doesNotMatch(team, /w-\[46%\]/)
})

test('the agent detail page owns no Back of its own', () => {
  // `/agents/:id` is a real depth-2 route (parent Agents), so the shared route
  // Back returns there. Its old registration outranked the knowledge stages
  // inside the Documents tab and left the agent instead of unwinding.
  const page = readSource('../src/pages/AgentDetailPage.tsx')
  assert.doesNotMatch(page, /useLocalBack/)
  assert.doesNotMatch(page, /LOCAL_BACK_PRIORITY/)
  // Wider layouts keep their own Back beside the title — since step 9 that
  // is `ScreenHeader`'s `onBack`, rendered only because the registry says
  // this screen has a parent (docs/navigation/overview.md §9).
  assert.match(page, /<ScreenHeader/)
  assert.match(page, /onBack=\{backToList\}/)
  assert.match(page, /backLabel="Back to Agents"/)

  assert.equal(matchSurface('/agents/agent_a')?.surface.depth, 2)
  assert.deepEqual(surfaceParent('/agents/agent_a'), {
    label: 'Back to Agents',
    pathname: '/agents',
  })
})
