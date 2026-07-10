import assert from 'node:assert/strict'
import test from 'node:test'

import { htmlToPlainText } from '@nessie/schemas'
import { chunkKnowledgePageBody } from '../src/index.js'

test('chunkKnowledgePageBody chunks the canonical plain-text page projection', async () => {
  const body = `
    <h1>Runbook</h1>
    <p>Storage quota is enforced before uploads and every blob operation goes through FileService.</p>
    <p>Hybrid retrieval combines lexical and semantic candidates with reciprocal rank fusion.</p>
  `
  const plainText = htmlToPlainText(body)
  const chunks = await chunkKnowledgePageBody(body, {
    chunkSize: 70,
    minCharactersPerChunk: 10,
  })

  assert.ok(chunks.length >= 2)
  assert.deepEqual(
    chunks.map((chunk) => chunk.chunkIndex),
    chunks.map((_, index) => index),
  )

  for (const chunk of chunks) {
    assert.equal(plainText.slice(chunk.startOffset, chunk.endOffset), chunk.content)
    assert.match(chunk.contentHash, /^[a-f0-9]{64}$/)
    assert.ok(!chunk.content.includes('<p>'))
    assert.ok(chunk.tokenCount > 0)
  }
})

test('chunkKnowledgePageBody drops empty page bodies', async () => {
  assert.deepEqual(await chunkKnowledgePageBody('<p> </p>'), [])
  assert.deepEqual(await chunkKnowledgePageBody(null), [])
})

