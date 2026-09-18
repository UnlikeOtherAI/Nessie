import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_LOCAL_WEIGHTS_BASE_URL,
  LocalModelEntrySchema,
  findLocalModel,
  listLocalModels,
  localModelFileUrl,
  localModelFiles,
} from '../local-inference.js'

test('every catalogue entry satisfies its own schema', () => {
  for (const entry of listLocalModels()) {
    const parsed = LocalModelEntrySchema.safeParse(entry)
    assert.equal(parsed.success, true, `${entry.id} failed: ${JSON.stringify(parsed.error?.issues)}`)
  }
})

test('the digest in every key is the digest that is pinned', () => {
  // The key is self-describing on purpose: a different build cannot reuse it,
  // and a reviewer reading a bucket listing can check the pin without the code.
  for (const entry of listLocalModels()) {
    for (const file of localModelFiles(entry)) {
      const segments = file.key.split('/')
      assert.ok(
        segments.includes(file.sha256),
        `${entry.id}: key ${file.key} does not contain its sha256`,
      )
    }
  }
})

test('no pin is empty — the thing Kelpie shipped and we cannot', () => {
  for (const entry of listLocalModels()) {
    for (const file of localModelFiles(entry)) {
      assert.match(file.sha256, /^[0-9a-f]{64}$/)
      assert.ok(file.bytes > 0)
    }
  }
})

test('ids, ollama names and object keys are each unique', () => {
  const entries = listLocalModels()
  const ids = new Set(entries.map((entry) => entry.id))
  const names = new Set(entries.map((entry) => entry.ollama.name))
  const keys = entries.flatMap((entry) => localModelFiles(entry).map((file) => file.key))
  assert.equal(ids.size, entries.length)
  assert.equal(names.size, entries.length)
  assert.equal(new Set(keys).size, keys.length)
})

test('findLocalModel refuses an id that is not in the catalogue', () => {
  assert.equal(findLocalModel('gemma4-e4b-q4')?.id, 'gemma4-e4b-q4')
  assert.equal(findLocalModel('gemma4-e4b-q2'), undefined)
  assert.equal(findLocalModel('../../etc/passwd'), undefined)
  assert.equal(findLocalModel('latest'), undefined)
})

test('the catalogue cannot be mutated through what it hands out', () => {
  const first = findLocalModel('gemma4-e2b-q4')
  assert.ok(first)
  first.weights.sha256 = '0'.repeat(64)
  first.platforms.push('windows')
  assert.notEqual(findLocalModel('gemma4-e2b-q4')?.weights.sha256, '0'.repeat(64))
  assert.equal(findLocalModel('gemma4-e2b-q4')?.platforms.length, 3)
})

test('a file URL is the configured host plus the entry key, with no double slash', () => {
  const entry = findLocalModel('gemma4-e2b-q4')
  assert.ok(entry)
  assert.equal(
    localModelFileUrl(entry.weights, 'https://mirror.example.com'),
    `https://mirror.example.com/${entry.weights.key}`,
  )
  assert.equal(
    localModelFileUrl(entry.weights, 'https://mirror.example.com/'),
    `https://mirror.example.com/${entry.weights.key}`,
  )
})

test('the default mirror is https', () => {
  assert.equal(new URL(DEFAULT_LOCAL_WEIGHTS_BASE_URL).protocol, 'https:')
})

test('the Q4 entries are the default and the Q8 entries are the higher-quality option', () => {
  for (const entry of listLocalModels()) {
    assert.equal(entry.quality, entry.quantization === 'q4_0' ? 'default' : 'higher')
  }
})

test('requested context never exceeds the window the model declares', () => {
  for (const entry of listLocalModels()) {
    assert.ok(entry.defaultNumCtx <= entry.contextWindow)
  }
})
