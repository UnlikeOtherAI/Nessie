import assert from 'node:assert/strict'
import test from 'node:test'

import { descriptorFor } from './executor-tool-descriptors.js'
import {
  normalizeExecutorMcpCallArguments,
  shapeExecutorToolArguments,
} from './executor-tool-arguments.js'

const navigateSchema = {
  properties: {
    headless: { type: 'boolean' },
    label: { type: 'string' },
    options: { type: 'object' },
    timeoutMs: { type: 'integer' },
    zoom: { type: 'number' },
  },
  type: 'object',
}

const schemaOf = (server: string, tool: string) =>
  server === 'kelpie' && tool === 'navigate' ? navigateSchema : undefined

const mcpCallSchema = descriptorFor('mcp.call', { mcpServers: ['kelpie'] })!.inputSchema

test('a JSON-string `arguments` object is parsed at the dispatch envelope', () => {
  const shaped = shapeExecutorToolArguments('mcp.call', mcpCallSchema, {
    arguments: '{"url":"https://example.com","timeoutMs":5000}',
    server: 'kelpie',
    tool: 'wait',
  }, schemaOf)
  assert.deepEqual(shaped.arguments, { timeoutMs: 5_000, url: 'https://example.com' })
})

test('a string that is not an object stays a string, so the daemon names the fault', () => {
  const shaped = shapeExecutorToolArguments('mcp.call', mcpCallSchema, {
    arguments: '[1,2]',
    server: 'kelpie',
    tool: 'wait',
  }, schemaOf)
  assert.equal(shaped.arguments, '[1,2]')
})

test('other executor tools get the same top-level correction against their own schema', () => {
  const fileRead = descriptorFor('file.read')!.inputSchema
  assert.deepEqual(
    shapeExecutorToolArguments('file.read', fileRead, { maxBytes: '4096', path: 'notes.md' }, schemaOf),
    { maxBytes: 4_096, path: 'notes.md' },
  )
  const observe = descriptorFor('browser.observe')!.inputSchema
  assert.deepEqual(
    shapeExecutorToolArguments('browser.observe', observe, { includeScreenshot: 'true' }, schemaOf),
    { includeScreenshot: true },
  )
})

test('inner scalars are shaped to the program’s advertised types once the run has listed it', () => {
  const shaped = normalizeExecutorMcpCallArguments({
    arguments: { headless: 'false', label: '40', timeoutMs: '40', url: 'https://example.com', zoom: '1.5' },
    server: 'kelpie',
    tool: 'navigate',
  }, schemaOf)
  assert.deepEqual(shaped.arguments, {
    headless: false,
    // A declared string is never touched, even when it looks like a number.
    label: '40',
    timeoutMs: 40,
    // Undeclared fields pass through untouched.
    url: 'https://example.com',
    zoom: 1.5,
  })
})

test('only strings that parse cleanly are shaped, and never into an object', () => {
  const args = {
    arguments: { headless: 'yes', options: '{"a":1}', timeoutMs: '1.5', zoom: 'fast' },
    server: 'kelpie',
    tool: 'navigate',
  }
  // Nothing parsed cleanly, so the arguments are handed on by identity.
  assert.equal(normalizeExecutorMcpCallArguments(args, schemaOf), args)
})

test('a tool the run has not listed is forwarded exactly as the model sent it', () => {
  const unlisted = { arguments: { timeoutMs: '40' }, server: 'kelpie', tool: 'click' }
  assert.equal(normalizeExecutorMcpCallArguments(unlisted, schemaOf), unlisted)
  const beforeListing = { arguments: { timeoutMs: '40' }, server: 'kelpie', tool: 'navigate' }
  assert.equal(normalizeExecutorMcpCallArguments(beforeListing, () => undefined), beforeListing)
})

test('only mcp.call has inner arguments to shape', () => {
  const fileRead = descriptorFor('file.read')!.inputSchema
  const args = { arguments: { timeoutMs: '40' }, path: 'a', server: 'kelpie', tool: 'navigate' }
  assert.deepEqual(shapeExecutorToolArguments('file.read', fileRead, args, schemaOf).arguments, { timeoutMs: '40' })
})
