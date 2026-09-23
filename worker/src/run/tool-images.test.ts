import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildToolImagesMessage,
  isToolImagesMessage,
  readToolImageRefs,
  TOOL_IMAGES_INTRO,
  TOOL_IMAGES_PROVENANCE,
} from './tool-images.js'

const ref = (n: number, byteLength = 134_144) => ({
  attachmentId: `0b7c6a8e-3f1d-4c2a-9e5b-7d8f9a0b1c${String(n).padStart(2, '0')}`,
  byteLength,
  mimeType: 'image/png',
})

test('one turn carries a batch’s images as refs, named the way their result named them', () => {
  const message = buildToolImagesMessage([
    { toolName: 'executor_mcp_call', imageRefs: [ref(1), ref(2, 13_715)] },
  ])
  assert.ok(message && isToolImagesMessage(message))
  assert.equal(message.role, 'user')
  assert.equal(message.provenance, TOOL_IMAGES_PROVENANCE)
  assert.deepEqual(message.content.split('\n'), [
    TOOL_IMAGES_INTRO,
    '[image 1: screenshot, 131 KB] from executor_mcp_call',
    '[image 2: screenshot, 13 KB] from executor_mcp_call',
  ])
  assert.deepEqual(message.toolImages.map(({ line: _line, ...image }) => image), [ref(1), ref(2, 13_715)])
  assert.equal(message.images, undefined, 'the transcript never holds the bytes')
})

test('several calls with images say which call each came from', () => {
  const message = buildToolImagesMessage([
    { toolName: 'executor_mcp_call', imageRefs: [ref(1)] },
    { toolName: 'web_search' },
    { toolName: 'default.executor_mcp_call', imageRefs: [ref(3)] },
  ])
  assert.ok(message && isToolImagesMessage(message))
  assert.deepEqual(message.content.split('\n').slice(1), [
    '[image 1: screenshot, 131 KB] from executor_mcp_call, call 1 of 3 above',
    '[image 1: screenshot, 131 KB] from default.executor_mcp_call, call 3 of 3 above',
  ])
})

test('a batch without images adds no turn', () => {
  assert.equal(buildToolImagesMessage([{ toolName: 'web_search' }, { imageRefs: [], toolName: 'x' }]), null)
})

test('refs read back from stored JSON are taken only when well formed', () => {
  assert.deepEqual(readToolImageRefs([
    ref(1),
    { ...ref(2), attachmentId: 'not-a-uuid' },
    { ...ref(3), mimeType: 'image/svg+xml' },
    { ...ref(4), byteLength: 5 * 1024 * 1024 },
    { ...ref(5), byteLength: 0 },
    { ...ref(6), dataBase64: 'AAAA' },
    null,
  ]), [ref(1), ref(6)].map(({ attachmentId, byteLength, mimeType }) => ({ attachmentId, byteLength, mimeType })))
  assert.deepEqual(readToolImageRefs('nope'), [])
  // A replayed result whose refs are all malformed adds no turn.
  assert.equal(buildToolImagesMessage([{ imageRefs: [{ attachmentId: 'x' }], toolName: 'executor_mcp_call' }]), null)
})

test('only the structural marker makes a turn a tool-images turn, never its words', () => {
  assert.equal(isToolImagesMessage({ content: TOOL_IMAGES_INTRO, role: 'user' }), false)
  assert.equal(isToolImagesMessage({ content: 'x', role: 'system' }), false)
})
