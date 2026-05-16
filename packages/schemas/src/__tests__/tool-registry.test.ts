import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  PromptMergeModeSchema,
  ToolBasePromptSchema,
  ToolCommonPromptSchema,
  ToolRegistryEntryExtensionsSchema,
} from '../tools.js'

test('PromptMergeModeSchema accepts the three spec modes', () => {
  for (const mode of ['append', 'prepend', 'replace'] as const) {
    assert.equal(PromptMergeModeSchema.parse(mode), mode)
  }
})

test('PromptMergeModeSchema rejects unknown modes', () => {
  assert.throws(() => PromptMergeModeSchema.parse('overwrite'))
})

test('ToolBasePromptSchema defaults match the spec backfill', () => {
  const parsed = ToolBasePromptSchema.parse({})
  assert.equal(parsed.content, '')
  assert.equal(parsed.mergeMode, 'append')
})

test('ToolBasePromptSchema honours explicit values', () => {
  const parsed = ToolBasePromptSchema.parse({
    content: 'be careful',
    mergeMode: 'prepend',
  })
  assert.equal(parsed.content, 'be careful')
  assert.equal(parsed.mergeMode, 'prepend')
})

test('ToolCommonPromptSchema requires enabledPrompt + overrideMode', () => {
  assert.throws(() =>
    ToolCommonPromptSchema.parse({ overrideMode: 'append' }),
  )
  assert.throws(() =>
    ToolCommonPromptSchema.parse({ enabledPrompt: 'go' }),
  )
  const parsed = ToolCommonPromptSchema.parse({
    enabledPrompt: 'go',
    overrideMode: 'replace',
  })
  assert.equal(parsed.enabledPrompt, 'go')
  assert.equal(parsed.overrideMode, 'replace')
})

test('ToolCommonPromptSchema accepts optional overview/blocked prompts', () => {
  const parsed = ToolCommonPromptSchema.parse({
    enabledPrompt: 'go',
    overviewPrompt: 'tool overview',
    blockedPrompt: 'denied',
    overrideMode: 'append',
  })
  assert.equal(parsed.overviewPrompt, 'tool overview')
  assert.equal(parsed.blockedPrompt, 'denied')
})

test('ToolRegistryEntryExtensionsSchema backfills every new spec column', () => {
  const parsed = ToolRegistryEntryExtensionsSchema.parse({
    source: 'builtin',
    transport: 'direct',
  })
  assert.deepEqual(parsed.transportConfig, {})
  assert.deepEqual(parsed.inputSchema, {})
  assert.deepEqual(parsed.tags, [])
  assert.deepEqual(parsed.baseSearchTerms, [])
  assert.deepEqual(parsed.allowSearchTerms, [])
  assert.deepEqual(parsed.basePrompt, { content: '', mergeMode: 'append' })
  assert.deepEqual(parsed.defaultConfig, {})
  assert.equal(parsed.overview, '')
  assert.equal(parsed.instructions, '')
  assert.equal(parsed.searchableText, '')
  assert.equal(parsed.owner, 'system')
  assert.equal(parsed.status, 'active')
  assert.equal(parsed.version, '0.0.0')
  assert.equal(parsed.createdBy, 'system')
})

test('ToolRegistryEntryExtensionsSchema rejects empty owner', () => {
  assert.throws(() =>
    ToolRegistryEntryExtensionsSchema.parse({
      source: 'builtin',
      transport: 'direct',
      owner: '',
    }),
  )
})

test('ToolRegistryEntryExtensionsSchema rejects empty createdBy', () => {
  assert.throws(() =>
    ToolRegistryEntryExtensionsSchema.parse({
      source: 'builtin',
      transport: 'direct',
      createdBy: '',
    }),
  )
})

test('ToolRegistryEntryExtensionsSchema preserves explicit prompt blocks', () => {
  const parsed = ToolRegistryEntryExtensionsSchema.parse({
    source: 'mcp-remote',
    transport: 'mcp',
    basePrompt: { content: 'caller', mergeMode: 'replace' },
    commonPrompt: {
      enabledPrompt: 'use carefully',
      overrideMode: 'append',
    },
    baseSearchTerms: ['search', 'web'],
    allowSearchTerms: ['allowed'],
    overview: 'web search',
    instructions: 'pass a query',
    searchableText: 'web search query',
    owner: 'role:admin',
  })
  assert.deepEqual(parsed.basePrompt, {
    content: 'caller',
    mergeMode: 'replace',
  })
  assert.deepEqual(parsed.commonPrompt, {
    enabledPrompt: 'use carefully',
    overrideMode: 'append',
  })
  assert.deepEqual(parsed.baseSearchTerms, ['search', 'web'])
  assert.deepEqual(parsed.allowSearchTerms, ['allowed'])
  assert.equal(parsed.overview, 'web search')
  assert.equal(parsed.instructions, 'pass a query')
  assert.equal(parsed.searchableText, 'web search query')
  assert.equal(parsed.owner, 'role:admin')
})

test('ToolRegistryEntryExtensionsSchema rejects unknown source/transport', () => {
  assert.throws(() =>
    ToolRegistryEntryExtensionsSchema.parse({
      source: 'wat',
      transport: 'direct',
    }),
  )
  assert.throws(() =>
    ToolRegistryEntryExtensionsSchema.parse({
      source: 'builtin',
      transport: 'carrier-pigeon',
    }),
  )
})
