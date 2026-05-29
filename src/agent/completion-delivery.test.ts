/**
 * src/agent/completion-delivery.test.ts — Tests for direct media delivery.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  extractMediaUrls,
  generateDeliveryIdempotencyKey,
  wasDelivered,
  markDelivered,
  tryDirectMediaDelivery,
  getDeliverySummary,
} from './completion-delivery.js'
import type { TaskResult, DeliveryContext } from './completion-delivery.js'

// ─── extractMediaUrls ────────────────────────────────────────────────────────

test('extractMediaUrls finds MEDIA paths', () => {
  const result = 'Generated image: MEDIA/abc123/image.png and another MEDIA/xyz/music.mp3'
  const urls = extractMediaUrls(result)
  assert.equal(urls.length, 2)
  assert.ok(urls.includes('MEDIA/abc123/image.png'))
  assert.ok(urls.includes('MEDIA/xyz/music.mp3'))
})

test('extractMediaUrls finds HTTP media URLs', () => {
  const result = 'Here is an image: https://example.com/photo.jpg and video: http://site.com/movie.mp4'
  const urls = extractMediaUrls(result)
  assert.equal(urls.length, 2)
  assert.ok(urls.includes('https://example.com/photo.jpg'))
  assert.ok(urls.includes('http://site.com/movie.mp4'))
})

test('extractMediaUrls deduplicates', () => {
  const result = 'Same image twice: https://example.com/photo.jpg and https://example.com/photo.jpg'
  const urls = extractMediaUrls(result)
  assert.equal(urls.length, 1)
})

test('extractMediaUrls returns empty for non-media', () => {
  const result = 'Just some text without any media URLs'
  const urls = extractMediaUrls(result)
  assert.equal(urls.length, 0)
})

// ─── Idempotency ─────────────────────────────────────────────────────────────

test('generateDeliveryIdempotencyKey format', () => {
  const task: TaskResult = {
    taskId: 'task-123',
    parentTaskId: 'parent-456',
    status: 'completed',
    result: 'some media',
    duration: 1000,
    toolCallCount: 2,
  }
  const target: DeliveryContext = { targetChannel: '#general' }
  const key = generateDeliveryIdempotencyKey(task, target, 'hash123')

  assert.ok(key.includes('completed'))
  assert.ok(key.includes('task-123'))
  assert.ok(key.includes('#general'))
  assert.ok(key.includes('hash123'))
})

test('wasDelivered / markDelivered cycle', () => {
  const key = 'test-key-1'

  assert.equal(wasDelivered(key), false)

  markDelivered(key, 1000)
  assert.equal(wasDelivered(key), true)
})

test('markDelivered respects TTL', async () => {
  const key = 'test-key-ttl'

  markDelivered(key, 50) // 50ms TTL
  assert.equal(wasDelivered(key), true)

  await new Promise((resolve) => setTimeout(resolve, 100))

  assert.equal(wasDelivered(key), false)
})

// ─── tryDirectMediaDelivery ──────────────────────────────────────────────────

test('tryDirectMediaDelivery: no media → success', async () => {
  const task: TaskResult = {
    taskId: 'task-1',
    parentTaskId: null,
    status: 'completed',
    result: 'Just text, no media',
    duration: 100,
    toolCallCount: 0,
  }

  const result = await tryDirectMediaDelivery(task, {})
  assert.equal(result.success, true)
  assert.equal(result.idempotencyKey, '')
})

test('tryDirectMediaDelivery: with media, no deliverFn → failure', async () => {
  const task: TaskResult = {
    taskId: 'task-2',
    parentTaskId: null,
    status: 'completed',
    result: 'Image: https://example.com/photo.png',
    duration: 100,
    toolCallCount: 1,
  }

  const result = await tryDirectMediaDelivery(task, {})
  assert.equal(result.success, false)
  assert.ok(result.idempotencyKey.length > 0)
  assert.ok(result.error?.includes('No delivery function'))
})

test('tryDirectMediaDelivery: with media, deliverFn succeeds', async () => {
  const task: TaskResult = {
    taskId: 'task-3',
    parentTaskId: null,
    status: 'completed',
    result: 'Image: https://example.com/photo.png',
    duration: 100,
    toolCallCount: 1,
  }

  const deliverFn = async (_urls: string[], _target: DeliveryContext) => true

  const result = await tryDirectMediaDelivery(task, { targetChannel: '#general' }, deliverFn)
  assert.equal(result.success, true)
  assert.ok(result.idempotencyKey.length > 0)
})

test('tryDirectMediaDelivery: with media, deliverFn fails', async () => {
  const task: TaskResult = {
    taskId: 'task-4',
    parentTaskId: null,
    status: 'completed',
    result: 'Image: https://example.com/photo.png',
    duration: 100,
    toolCallCount: 1,
  }

  const deliverFn = async (_urls: string[], _target: DeliveryContext) => false

  const result = await tryDirectMediaDelivery(task, { targetChannel: '#general' }, deliverFn)
  assert.equal(result.success, false)
  assert.ok(result.error?.includes('returned false'))
})

test('tryDirectMediaDelivery: with media, deliverFn throws', async () => {
  const task: TaskResult = {
    taskId: 'task-5',
    parentTaskId: null,
    status: 'completed',
    result: 'Image: https://example.com/photo.png',
    duration: 100,
    toolCallCount: 1,
  }

  const deliverFn = async (_urls: string[], _target: DeliveryContext) => {
    throw new Error('Network error')
  }

  const result = await tryDirectMediaDelivery(task, { targetChannel: '#general' }, deliverFn)
  assert.equal(result.success, false)
  assert.equal(result.error, 'Network error')
})

test('tryDirectMediaDelivery: idempotency blocks duplicate', async () => {
  const task: TaskResult = {
    taskId: 'task-6',
    parentTaskId: null,
    status: 'completed',
    result: 'Image: https://example.com/photo.png',
    duration: 100,
    toolCallCount: 1,
  }

  const deliverFn = async (_urls: string[], _target: DeliveryContext) => true

  // First attempt
  const r1 = await tryDirectMediaDelivery(task, { targetChannel: '#general' }, deliverFn)
  assert.equal(r1.success, true)

  // Second attempt should be blocked by idempotency
  const r2 = await tryDirectMediaDelivery(task, { targetChannel: '#general' }, deliverFn)
  assert.equal(r2.success, true)
  assert.equal(r2.idempotencyKey, r1.idempotencyKey)
})

test('tryDirectMediaDelivery: non-media completions unaffected', async () => {
  const task: TaskResult = {
    taskId: 'task-7',
    parentTaskId: null,
    status: 'completed',
    result: 'Task completed successfully with text output only',
    duration: 100,
    toolCallCount: 1,
  }

  const deliverFn = async (_urls: string[], _target: DeliveryContext) => {
    throw new Error('Should not be called')
  }

  const result = await tryDirectMediaDelivery(task, {}, deliverFn)
  assert.equal(result.success, true)
})

// ─── getDeliverySummary ──────────────────────────────────────────────────────

test('getDeliverySummary singular', () => {
  const task: TaskResult = {
    taskId: 'task-8',
    parentTaskId: null,
    status: 'completed',
    result: '',
    duration: 100,
    toolCallCount: 1,
  }

  const summary = getDeliverySummary(task, 1)
  assert.ok(summary.includes('task-8'))
  assert.ok(summary.includes('1 media item'))
})

test('getDeliverySummary plural', () => {
  const task: TaskResult = {
    taskId: 'task-9',
    parentTaskId: null,
    status: 'completed',
    result: '',
    duration: 100,
    toolCallCount: 1,
  }

  const summary = getDeliverySummary(task, 3)
  assert.ok(summary.includes('3 media items'))
})
