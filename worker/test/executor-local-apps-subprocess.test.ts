import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { executeExecutorMcpCommand } from '../../executor/src/mcp-dispatch.js'
import { createExecutorMcpSessionManager } from '../../executor/src/mcp-session-manager.js'
import { createExecutorMcpCatalogs } from '../src/run/executor-mcp-catalog.js'
import {
  presentExecutorMcpCatalogAnswer,
  presentExecutorResultForModel,
} from '../src/run/executor-result-presentation.js'
import { descriptorFor } from '../src/run/executor-tool-descriptors.js'
import { shapeExecutorToolArguments } from '../src/run/executor-tool-arguments.js'
import { executorDispatchResult } from '../src/run/executor-toolset.js'
import type { AgenticToolResult } from '../src/run/tools.js'

/**
 * The worker's half of the local-apps lane against a real MCP program: a
 * browser-like server subprocess behind the daemon's own operation and
 * session manager. The toolset's control-plane hop (a queued, encrypted
 * command and its receipt) is replaced by a direct call, which carries the
 * same JSON both ways; everything the worker does to the call and to the
 * answer is the shipped code — the envelope argument shaping, the run's
 * catalog walked in pages, and the presentation the model reads.
 */

const SCRIPT = fileURLToPath(new URL('../../executor/test/fixtures/scripted-mcp-server.mjs', import.meta.url))

const lane = (mode = 'local-apps', maxResultBytes = 65_536) => {
  const sessions = createExecutorMcpSessionManager([{
    command: [process.execPath, SCRIPT],
    env: { NESSIE_TEST_MCP_MODE: mode },
    name: 'kelpie',
  }], { maxResultBytes }, { log: () => undefined, startTimeoutMs: 15_000 })
  const pages: unknown[] = []
  const ended: string[] = []
  let pageRecord = 0
  const listPage = async (args: { cursor?: string; server: string }): Promise<AgenticToolResult> => {
    pages.push(args)
    pageRecord += 1
    return {
      inputSummary: '',
      ...executorDispatchResult(await executeExecutorMcpCommand('mcp.tools', args, sessions)),
      toolCallRecordId: `page-record-${pageRecord}`,
    }
  }
  const catalogs = createExecutorMcpCatalogs({
    endPage: async (toolCallRecordId) => {
      ended.push(toolCallRecordId)
    },
    listPage,
    mcpServers: () => ['kelpie'],
  })
  const mcpCall = descriptorFor('mcp.call', { mcpServers: ['kelpie'] })!.inputSchema
  // The daemon keeps a call's images as sidecars; here they are only counted.
  const keptImages: number[] = []
  // What the agent loop runs for executor_mcp_call: the envelope shaping, the
  // daemon operation, the raw document, then the model's presentation.
  const call = async (args: Record<string, unknown>) => {
    const shaped = shapeExecutorToolArguments('mcp.call', mcpCall, args, catalogs.inputSchemaOf)
    const raw = {
      inputSummary: '',
      ...executorDispatchResult(await executeExecutorMcpCommand('mcp.call', shaped, sessions, async (images) => {
        keptImages.push(...images.map((image) => image.bytes.length))
      })),
    }
    return { presented: presentExecutorResultForModel('mcp.call', args, raw), raw }
  }
  return { call, catalogs, ended, keptImages, pages, sessions }
}

type NavigateEcho = { arguments: Record<string, unknown>; types: Record<string, string> }

// The navigate tool answers with what it received and each value's type.
const echoOf = (raw: { output: string }): NavigateEcho =>
  JSON.parse((JSON.parse(raw.output) as { content: Array<{ text: string }> }).content[0]!.text) as NavigateEcho

test('once the run has listed the program, a string scalar reaches it as the type it declared', async () => {
  const { call, catalogs, sessions } = lane()
  try {
    const args = {
      // The whole `arguments` object as a JSON string, the way weaker models send it.
      arguments: JSON.stringify({ headless: 'false', timeoutMs: '5000', url: 'https://example.com', zoom: '1.25' }),
      server: 'kelpie',
      tool: 'navigate',
    }
    const before = await call(args)
    const beforeEcho = echoOf(before.raw)
    // Unlisted: the object is parsed at the envelope, its scalars left alone.
    assert.deepEqual(beforeEcho.types, { headless: 'string', timeoutMs: 'string', url: 'string', zoom: 'string' })

    const listed = await catalogs.load('kelpie', 'call-1')
    assert.ok(!('failure' in listed))
    const after = await call(args)
    const afterEcho = echoOf(after.raw)
    assert.deepEqual(afterEcho.arguments, { headless: false, timeoutMs: 5_000, url: 'https://example.com', zoom: 1.25 })
    assert.deepEqual(afterEcho.types, { headless: 'boolean', timeoutMs: 'number', url: 'string', zoom: 'number' })
  } finally {
    await sessions.stopAll()
  }
})

test('a real screenshot answer reads as text and placeholders, never as base64 or a host path', async () => {
  const { call, keptImages, sessions } = lane()
  try {
    const { presented, raw } = await call({ server: 'kelpie', tool: 'screenshot' })
    assert.equal(raw.success, true)
    assert.match(raw.output, /"type":"image"/, 'dispatch still answers the raw document')
    // The daemon took the bytes out and left a reference to them.
    assert.match(raw.output, /"attachmentDigest":"sha256:[0-9a-f]{64}"/)
    assert.deepEqual(keptImages, [3_000])
    // With no attachment behind the reference the model is told so.
    assert.ok(presented.output.split('\n').includes('[image unavailable: Nessie does not hold it for this call]'))
    assert.equal(presented.imageRefs, undefined)
    // Where the upload was kept, the reference resolves to its attachment.
    const reference = (JSON.parse(raw.output) as { content: Array<Record<string, unknown>> }).content
      .find((item) => item.type === 'image')!
    const kept = { attachmentId: '2a6f1c3e-8b4d-4e7a-9c1f-3d5b7e9a1c2e', byteLength: 3_000, mimeType: 'image/png' }
    const shown = presentExecutorResultForModel(
      'mcp.call',
      { server: 'kelpie', tool: 'screenshot' },
      raw,
      new Map([[reference.attachmentDigest as string, kept]]),
    )
    const lines = shown.output.split('\n')
    assert.equal(lines[0], 'BEGIN UNTRUSTED EXTERNAL DATA')
    assert.match(lines[1]!, /^Output of the program `kelpie` on the person's machine\./)
    assert.ok(lines.includes('Captured the page.'))
    assert.ok(lines.includes('[image 1: screenshot, 3 KB]'))
    assert.deepEqual(shown.imageRefs, [kept])
    assert.ok(lines.includes('[resource: page.png]'))
    assert.doesNotMatch(shown.output, /BwcHBwcH|file:\/\/|private/)
  } finally {
    await sessions.stopAll()
  }
})

test('structured-only content and a program error are presented by the same rules', async () => {
  const { call, sessions } = lane()
  try {
    const metrics = await call({ server: 'kelpie', tool: 'metrics' })
    assert.ok(metrics.presented.output.split('\n').includes('{"nodes":412,"title":"Example Domain"}'))

    const failed = await call({ server: 'kelpie', tool: 'wait_for_element', arguments: { selector: '#submit' } })
    assert.equal(failed.presented.success, false)
    assert.equal(failed.presented.output.split('\n')[0], 'The program reported an error:')
    assert.match(failed.presented.output, /No element matched #submit\./)
  } finally {
    await sessions.stopAll()
  }
})

test('an envelope the daemon refuses names the field, and the model reads it', async () => {
  const { sessions } = lane()
  try {
    const refused = executorDispatchResult(await executeExecutorMcpCommand('mcp.call', {
      arguments: '{not json',
      server: 'kelpie',
      tool: 'navigate',
    }, sessions))
    assert.equal(refused.success, false)
    assert.equal(refused.correctable, true)
    const presented = presentExecutorResultForModel('mcp.call', { server: 'kelpie' }, { inputSummary: '', ...refused })
    assert.equal(
      presented.output,
      'The call did not complete (EXECUTOR_COMMAND_ARGUMENTS_INVALID). '
      + 'The mcp.call arguments were refused — `arguments`: Expected object, received string.',
    )
  } finally {
    await sessions.stopAll()
  }
})

test('the run walks a paged catalog once and answers from its own copy after that', async () => {
  // Forty padded tools against an 8 KiB result budget make the daemon page.
  const { catalogs, ended, pages, sessions } = lane('many-tools', 8_192)
  try {
    const answer = await catalogs.load('kelpie', 'call-1')
    assert.ok(!('failure' in answer))
    assert.equal(answer.tools.length, 40)
    assert.ok(pages.length > 1, `expected pages, got ${pages.length}`)
    assert.equal(ended.length, pages.length - 1, 'every page after the first is ended by the walk')
    const listing = presentExecutorMcpCatalogAnswer({ server: 'kelpie' }, answer)
    assert.match(listing.output.split('\n')[0]!, /offers 40 tools/)
    assert.ok(listing.output.split('\n').includes('- tool_039: Tool 39.'))
    assert.equal(listing.toolCallRecordId, 'page-record-1')
    const walked = pages.length
    const schema = presentExecutorMcpCatalogAnswer({ server: 'kelpie', tool: 'tool_007' }, await catalogs.load('kelpie', 'call-2'))
    assert.ok(schema.output.split('\n').includes('Input schema: {"type":"object","properties":{"value":{"type":"string"}}}'))
    assert.equal(pages.length, walked, 'no second trip to the program')
  } finally {
    await sessions.stopAll()
  }
})
