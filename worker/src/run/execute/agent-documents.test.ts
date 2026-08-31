import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hasDocumentsPromptTools,
  hasKbWriteTools,
} from './agent-documents.js'

test('document homes are provisioned only for an assembled KB write tool', () => {
  assert.equal(hasKbWriteTools(new Set(['kb_search', 'kb_list'])), false)
  assert.equal(hasKbWriteTools(new Set(['kb_document_compose'])), true)
  assert.equal(hasKbWriteTools(new Set(['kb_document_edit'])), true)
})

test('the documents prompt requires every tool it names', () => {
  const complete = new Set([
    'kb_list',
    'kb_search',
    'kb_document_compose',
    'kb_document_edit',
  ])
  assert.equal(hasDocumentsPromptTools(complete), true)

  for (const missingTool of complete) {
    const partial = new Set(complete)
    partial.delete(missingTool)
    assert.equal(hasDocumentsPromptTools(partial), false, `missing ${missingTool}`)
  }
})
