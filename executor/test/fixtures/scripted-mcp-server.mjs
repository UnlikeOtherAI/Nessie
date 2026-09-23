#!/usr/bin/env node
/**
 * A real MCP server over stdio, used to prove the executor's bridge against a
 * process rather than a stub. A fake proves the bridge calls our own code; only
 * a process proves the JSON-RPC framing, the handshake, and the teardown.
 *
 * Its behaviour is chosen by NESSIE_TEST_MCP_MODE:
 *   ok            - two tools, both answer
 *   error-tool    - `boom` answers with isError
 *   die-on-call   - exits mid-call, to prove a crash is noticed
 *   never-start   - exits before the handshake, a launch failure
 *   huge          - answers with more bytes than any result budget
 *   many-tools    - enough tools to force catalog pagination
 *   local-apps    - a browser-like program: typed arguments, an image, a
 *                   resource link, structured-only content and an isError
 *   ollama-search - the `ollama-search` bridge's own catalog and answer
 *                   shapes, without its network account
 *   slow-pages    - its own tools/list paginated one tool a page, each page
 *                   answered after NESSIE_TEST_MCP_PAGE_DELAY_MS (200 ms)
 */
import { createInterface } from 'node:readline'

const mode = process.env.NESSIE_TEST_MCP_MODE ?? 'ok'

if (mode === 'never-start') process.exit(3)

// 3 000 bytes of PNG-looking payload, so a presentation can state its size.
const IMAGE_BASE64 = Buffer.alloc(3_000, 7).toString('base64')

const localAppsTools = [
  {
    name: 'navigate',
    description: 'Open a URL in the browser. Waits for the page to load.',
    inputSchema: {
      type: 'object',
      properties: {
        headless: { type: 'boolean' },
        timeoutMs: { type: 'integer' },
        url: { type: 'string' },
        zoom: { type: 'number' },
      },
      required: ['url'],
    },
  },
  { name: 'screenshot', description: 'Capture the page.', inputSchema: { type: 'object', properties: {} } },
  { name: 'metrics', description: 'Page metrics as structured data.', inputSchema: { type: 'object', properties: {} } },
  { name: 'wait_for_element', description: 'Wait for a selector.', inputSchema: { type: 'object', properties: { selector: { type: 'string' } } } },
]

// The same catalog `serve-ollama-search-mcp` answers (executor/src/ollama-search-mcp.ts).
const ollamaSearchTools = [
  {
    name: 'ollama_web_search',
    description: 'Search using this executor’s configured Ollama account. Returns source URLs and excerpts.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['query'],
      properties: { query: { type: 'string', minLength: 1, maxLength: 4_000 }, max_results: { type: 'integer', minimum: 1, maximum: 10 } },
    },
  },
  {
    name: 'ollama_web_fetch',
    description: 'Read a public page using this executor’s configured Ollama account.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['url'],
      properties: { url: { type: 'string', minLength: 1, maxLength: 4_000 } },
    },
  },
]

const tools = mode === 'many-tools'
  ? Array.from({ length: 40 }, (_, index) => ({
    name: `tool_${String(index).padStart(3, '0')}`,
    description: `Tool ${index}. ${'padding '.repeat(40)}`,
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
  }))
  : mode === 'local-apps' ? localAppsTools
  : mode === 'ollama-search' ? ollamaSearchTools
  : [
    {
      name: 'echo',
      description: 'Echo the value back.',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    },
    {
      name: 'boom',
      description: 'Always fails.',
      inputSchema: { type: 'object', properties: {} },
    },
  ]

const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

const localAppsResult = (name, args) => {
  if (name === 'navigate') {
    // Echo each argument with the type it arrived as, so a test can see what
    // the program itself received.
    const types = Object.fromEntries(Object.entries(args).map(([key, value]) => [key, typeof value]))
    return { content: [{ type: 'text', text: JSON.stringify({ arguments: args, types }) }] }
  }
  if (name === 'screenshot') {
    return {
      content: [
        { type: 'text', text: 'Captured the page.' },
        { type: 'image', data: IMAGE_BASE64, mimeType: 'image/png' },
        { type: 'resource_link', name: 'page.png', uri: 'file:///home/owner/private/page.png' },
      ],
    }
  }
  if (name === 'metrics') return { content: [], structuredContent: { nodes: 412, title: 'Example Domain' } }
  return { content: [{ type: 'text', text: 'No element matched #submit.' }], isError: true }
}

const ollamaSearchResult = (name, args) => {
  // The bridge reports its own failures as an isError text holding `{code}`.
  if (args.query === 'quota') {
    return { content: [{ type: 'text', text: JSON.stringify({ code: 'search_quota_exhausted' }) }], isError: true }
  }
  const body = name === 'ollama_web_search'
    ? { results: [{ content: 'An excerpt.', title: 'A source', url: 'https://example.com/' }] }
    : { content: 'Page text.', links: ['https://example.com/'], title: 'A page' }
  return { content: [{ type: 'text', text: JSON.stringify(body) }] }
}

const callResult = (request) => {
  const name = request.params?.name
  if (mode === 'die-on-call') {
    process.exit(7)
  }
  if (mode === 'local-apps') return localAppsResult(name, request.params?.arguments ?? {})
  if (mode === 'ollama-search') return ollamaSearchResult(name, request.params?.arguments ?? {})
  if (mode === 'huge') {
    return { content: [{ type: 'text', text: 'x'.repeat(200_000) }] }
  }
  if (name === 'boom' || mode === 'error-tool') {
    // `bytes` sizes the failure text, so a test can walk a result budget's edge.
    const bytes = request.params?.arguments?.bytes
    const text = Number.isSafeInteger(bytes) ? 'x'.repeat(bytes) : 'it failed'
    return { content: [{ type: 'text', text }], isError: true }
  }
  return {
    content: [{ type: 'text', text: JSON.stringify({ echoed: request.params?.arguments ?? null }) }],
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }
  if (request.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: request.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'scripted', version: '9.9.9' },
      },
    })
    return
  }
  if (request.method === 'notifications/initialized') return
  if (request.method === 'tools/list' && mode === 'slow-pages') {
    const offset = Number.parseInt(request.params?.cursor ?? '0', 10)
    const delay = Number.parseInt(process.env.NESSIE_TEST_MCP_PAGE_DELAY_MS ?? '200', 10)
    setTimeout(() => send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        tools: tools.slice(offset, offset + 1),
        ...(offset + 1 < tools.length ? { nextCursor: String(offset + 1) } : {}),
      },
    }), delay)
    return
  }
  if (request.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: request.id, result: { tools } })
    return
  }
  if (request.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: request.id, result: callResult(request) })
    return
  }
  if (request.id !== undefined) {
    send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })
  }
})
