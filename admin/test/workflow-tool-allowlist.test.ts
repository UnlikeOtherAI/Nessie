import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { WORKFLOW_TOOL_NODE_IDS } from '../src/lib/workflow-designer/constants'

// W12: one tool allow-list. The runtime exports WORKFLOW_TOOL_IDS
// (packages/runtime) and the API validates against it; the canvas cannot
// import that package, so this test is the derivation: it fails the moment
// the canvas list and the runtime list drift apart.
const runtimeToolIds = (() => {
  const source = readFileSync(
    new URL('../../packages/runtime/src/workflow-tools.ts', import.meta.url),
    'utf8',
  )
  // workflow-tools.ts declares each workflow tool literal (`id: 'state_get'`…);
  // web_search/web_fetch are passed in from builtin-tools.ts.
  const declared = [...source.matchAll(/id: '([a-z_]+)'/g)].map((match) => match[1]!)
  return new Set([...declared, 'web_search', 'web_fetch'])
})()

test('canvas tool list equals the runtime workflow tool ids', () => {
  assert.deepEqual([...WORKFLOW_TOOL_NODE_IDS].sort(), [...runtimeToolIds].sort())
})

test('the API validates against the same runtime list (no hand-maintained copy)', () => {
  const source = readFileSync(
    new URL('../../api/src/services/workflows.ts', import.meta.url),
    'utf8',
  )
  // The allow-list must come from the runtime package, not a literal list.
  assert.match(source, /import \{ WORKFLOW_TOOL_IDS \} from '@nessie\/runtime'/)
  assert.doesNotMatch(source, /'change_detect'/)
})
