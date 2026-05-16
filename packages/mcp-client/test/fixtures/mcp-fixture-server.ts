/**
 * Minimal local MCP fixture server.
 *
 * Speaks just enough of the Streamable-HTTP MCP transport so that
 * Nessie's universal client (and the admin install/discovery flow) can
 * exercise the catalog → install → probe → discovery → grant → invoke
 * round-trip on a single developer machine without any external service.
 *
 * Wire shape — single endpoint, two methods:
 *
 *   - `POST /mcp` accepts a JSON-RPC 2.0 request body (or array of
 *     requests). For requests with an `id`, the server responds
 *     `200 OK Content-Type: application/json` with a single JSON-RPC
 *     response body. For notifications (no `id`), it responds `202`.
 *     The `initialize` response also carries an `mcp-session-id`
 *     header that the client echoes on subsequent calls.
 *   - `GET /mcp` returns `405` — we do not advertise a server-initiated
 *     SSE stream; the universal client handles per-request responses
 *     just fine without one.
 *
 * Implementation rule: zero external dependencies. Only `node:http`,
 * `node:crypto`, and existing repo types from `../../src/types.js`.
 *
 * Bound to `127.0.0.1` only — never `0.0.0.0`. Default port `4318`,
 * overridable via `--port=<n>` so multiple devs sharing a tunnel can
 * still run side-by-side.
 */

import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

import type { McpToolDescriptor } from '../../src/types.js'

const PROTOCOL_VERSION = '2025-03-26'
const DEFAULT_PORT = 4318
const SERVER_NAME = 'nessie-mcp-fixture'
const SERVER_VERSION = '0.1.0'

type JsonRpcId = string | number | null

type JsonRpcRequest = {
  jsonrpc: '2.0'
  id?: JsonRpcId
  method: string
  params?: unknown
}

type JsonRpcSuccess = {
  jsonrpc: '2.0'
  id: JsonRpcId
  result: unknown
}

type JsonRpcFailure = {
  jsonrpc: '2.0'
  id: JsonRpcId
  error: { code: number; message: string; data?: unknown }
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure

/** Tool descriptors served by `tools/list`. */
const TOOLS: McpToolDescriptor[] = [
  {
    name: 'echo',
    description: 'Returns the input text verbatim. Useful as a connectivity smoke test.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo back.' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'now',
    description: 'Returns the current ISO-8601 UTC timestamp.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'fixture_add',
    description: 'Adds two numbers and returns the sum.',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number', description: 'First addend.' },
        b: { type: 'number', description: 'Second addend.' },
      },
      required: ['a', 'b'],
      additionalProperties: false,
    },
  },
]

function parsePort(argv: string[]): number {
  for (const arg of argv) {
    if (arg.startsWith('--port=')) {
      const raw = arg.slice('--port='.length)
      const n = Number.parseInt(raw, 10)
      if (!Number.isFinite(n) || n <= 0 || n > 65535) {
        throw new Error(`invalid --port value: ${raw}`)
      }
      return n
    }
    if (arg === '--port') {
      const idx = argv.indexOf(arg)
      const raw = argv[idx + 1]
      const n = Number.parseInt(raw ?? '', 10)
      if (!Number.isFinite(n) || n <= 0 || n > 65535) {
        throw new Error(`invalid --port value: ${raw}`)
      }
      return n
    }
  }
  return DEFAULT_PORT
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer))
  }
  if (chunks.length === 0) return undefined
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return undefined
  return JSON.parse(text)
}

function ok(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result }
}

function fail(id: JsonRpcId, code: number, message: string): JsonRpcFailure {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function asText(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] }
}

function handleRpc(req: JsonRpcRequest): JsonRpcResponse | null {
  const id = req.id ?? null
  switch (req.method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      })
    case 'notifications/initialized':
      // Notification — no response.
      return null
    case 'ping':
      return ok(id, {})
    case 'tools/list':
      return ok(id, { tools: TOOLS })
    case 'tools/call':
      return handleToolCall(id, req.params)
    default:
      return fail(id, -32601, `Method not found: ${req.method}`)
  }
}

function handleToolCall(id: JsonRpcId, params: unknown): JsonRpcResponse {
  if (!params || typeof params !== 'object') {
    return fail(id, -32602, 'tools/call requires params object')
  }
  const { name, arguments: args } = params as { name?: unknown; arguments?: unknown }
  if (typeof name !== 'string') {
    return fail(id, -32602, 'tools/call params.name must be a string')
  }
  const argObj = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  switch (name) {
    case 'echo': {
      const text = argObj.text
      if (typeof text !== 'string') {
        return fail(id, -32602, 'echo requires arguments.text: string')
      }
      return ok(id, asText(text))
    }
    case 'now':
      return ok(id, asText(new Date().toISOString()))
    case 'fixture_add': {
      const a = argObj.a
      const b = argObj.b
      if (typeof a !== 'number' || typeof b !== 'number') {
        return fail(id, -32602, 'fixture_add requires arguments.a and arguments.b: number')
      }
      return ok(id, asText(String(a + b)))
    }
    default:
      return fail(id, -32601, `Unknown tool: ${name}`)
  }
}

function isInitialize(message: JsonRpcRequest): boolean {
  return message.method === 'initialize'
}

async function handlePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch {
    res.statusCode = 400
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(fail(null, -32700, 'Parse error')))
    return
  }

  if (!body || typeof body !== 'object') {
    res.statusCode = 400
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(fail(null, -32600, 'Invalid Request')))
    return
  }

  const messages: JsonRpcRequest[] = Array.isArray(body)
    ? (body as JsonRpcRequest[])
    : [body as JsonRpcRequest]
  const responses: JsonRpcResponse[] = []
  let sawInitialize = false
  for (const msg of messages) {
    if (isInitialize(msg)) sawInitialize = true
    const out = handleRpc(msg)
    if (out !== null) responses.push(out)
  }

  if (sawInitialize) {
    // Streamable HTTP convention — first response carries the session id.
    res.setHeader('mcp-session-id', randomUUID())
  }

  if (responses.length === 0) {
    // All inputs were notifications — RPC convention: 202 Accepted, no body.
    res.statusCode = 202
    res.end()
    return
  }

  res.statusCode = 200
  res.setHeader('content-type', 'application/json')
  const payload = Array.isArray(body) ? responses : responses[0]
  res.end(JSON.stringify(payload))
}

function notFound(res: ServerResponse): void {
  res.statusCode = 404
  res.end()
}

function methodNotAllowed(res: ServerResponse): void {
  res.statusCode = 405
  res.setHeader('allow', 'POST')
  res.end()
}

export type FixtureHandle = {
  url: string
  port: number
  close: () => Promise<void>
}

export async function startMcpFixture(port = DEFAULT_PORT): Promise<FixtureHandle> {
  const server = createServer((req, res) => {
    if (!req.url || !req.url.startsWith('/mcp')) {
      notFound(res)
      return
    }
    if (req.method === 'POST') {
      handlePost(req, res).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error('[mcp-fixture] handler error', err)
        if (!res.headersSent) {
          res.statusCode = 500
          res.end()
        }
      })
      return
    }
    methodNotAllowed(res)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('failed to bind mcp fixture server')
  }
  const boundPort = address.port
  return {
    url: `http://127.0.0.1:${boundPort}/mcp`,
    port: boundPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}

async function main(): Promise<void> {
  const port = parsePort(process.argv.slice(2))
  const handle = await startMcpFixture(port)
  // eslint-disable-next-line no-console
  console.log(`[mcp-fixture] listening on ${handle.url}`)

  const shutdown = (signal: NodeJS.Signals): void => {
    handle
      .close()
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error(`[mcp-fixture] shutdown error on ${signal}`, err)
      })
      .finally(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

// Run when invoked directly (e.g. `tsx mcp-fixture-server.ts`).
// `import.meta.url` and `process.argv[1]` will match for direct invocation.
const invokedDirectly = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return import.meta.url === new URL(`file://${entry}`).href
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  main().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('[mcp-fixture] failed to start', err)
    process.exit(1)
  })
}
