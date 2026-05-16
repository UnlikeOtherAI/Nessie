/**
 * Minimal in-process MCP server harness for tests.
 *
 * We use the official SDK's `McpServer` to guarantee wire-level parity with
 * what a real server would emit.
 *
 *   - `startHttpFake()` boots a Node `http.Server` and routes `/mcp` to a
 *     `StreamableHTTPServerTransport`.
 *   - `startSseFake()` boots a Node `http.Server`, serves GET `/sse` as an
 *     `SSEServerTransport`, and accepts POST `/messages?sessionId=...`.
 *
 * The stdio fake server lives in `stdio-fake-server.ts` and is launched as a
 * child process via `node --import tsx <path>` from the stdio test itself.
 */

import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

export type FakeServerOptions = {
  /** Optional per-call delay applied to the `echo` tool, in milliseconds. */
  echoDelayMs?: number
  /** If provided, the server requires this exact bearer token. */
  requireBearer?: string
}

export function buildFakeMcpServer(opts: FakeServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'fake-mcp', version: '0.0.0' })
  server.registerTool(
    'echo',
    {
      description: 'Echo the input back to the caller.',
      inputSchema: { message: z.string() },
    },
    async (args) => {
      if (opts.echoDelayMs && opts.echoDelayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, opts.echoDelayMs))
      }
      return { content: [{ type: 'text', text: String(args.message ?? '') }] }
    },
  )
  server.registerTool(
    'add',
    {
      description: 'Add two integers.',
      inputSchema: { a: z.number(), b: z.number() },
    },
    async (args) => ({
      content: [{ type: 'text', text: String(args.a + args.b) }],
    }),
  )
  return server
}

/* ---------- streamable HTTP ---------- */

export type HttpFake = {
  url: string
  close: () => Promise<void>
  /** Forcefully drop all current connections, simulating a transport blip. */
  dropConnections: () => void
}

export async function startHttpFake(opts: FakeServerOptions = {}): Promise<HttpFake> {
  const transports = new Map<string, StreamableHTTPServerTransport>()
  const sockets = new Set<import('node:net').Socket>()

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!req.url?.startsWith('/mcp')) {
      res.statusCode = 404
      res.end()
      return
    }

    if (opts.requireBearer) {
      const auth = req.headers.authorization
      if (auth !== `Bearer ${opts.requireBearer}`) {
        res.statusCode = 401
        res.end('unauthorized')
        return
      }
    }

    const sessionHeader = req.headers['mcp-session-id']
    const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader

    let transport: StreamableHTTPServerTransport | undefined = sessionId
      ? transports.get(sessionId)
      : undefined

    if (!transport) {
      const created = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, created)
        },
      })
      created.onclose = (): void => {
        const sid = created.sessionId
        if (sid) transports.delete(sid)
      }
      const server = buildFakeMcpServer(opts)
      await server.connect(created)
      transport = created
    }

    let body: unknown
    if (req.method === 'POST') {
      body = await readJsonBody(req)
    }
    await transport.handleRequest(req, res, body)
  }

  const http = createServer((req, res) => {
    handler(req, res).catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('http fake handler error', err)
      try {
        if (!res.headersSent) {
          res.statusCode = 500
          res.end()
        }
      } catch {
        // socket already closed
      }
    })
  })

  http.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const address = http.address()
  if (!address || typeof address === 'string') {
    throw new Error('failed to bind http fake server')
  }
  const url = `http://127.0.0.1:${address.port}/mcp`

  return {
    url,
    close: async () => {
      for (const t of transports.values()) await t.close().catch(() => {})
      await new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy()
        http.close(() => resolve())
      })
    },
    dropConnections: () => {
      for (const s of sockets) s.destroy()
      sockets.clear()
    },
  }
}

/* ---------- SSE ---------- */

export type SseFake = {
  url: string
  close: () => Promise<void>
  /** Forcefully drop all active SSE streams. */
  dropConnections: () => void
}

export async function startSseFake(opts: FakeServerOptions = {}): Promise<SseFake> {
  const transports = new Map<string, SSEServerTransport>()
  const sockets = new Set<import('node:net').Socket>()
  let http: Server

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

    if (req.method === 'GET' && url.pathname === '/sse') {
      const transport = new SSEServerTransport('/messages', res)
      transports.set(transport.sessionId, transport)
      transport.onclose = (): void => {
        transports.delete(transport.sessionId)
      }
      const server = buildFakeMcpServer(opts)
      await server.connect(transport)
      return
    }

    if (req.method === 'POST' && url.pathname === '/messages') {
      const sessionId = url.searchParams.get('sessionId')
      const transport = sessionId ? transports.get(sessionId) : undefined
      if (!transport) {
        res.statusCode = 404
        res.end('unknown session')
        return
      }
      const body = await readJsonBody(req)
      await transport.handlePostMessage(req, res, body)
      return
    }

    res.statusCode = 404
    res.end()
  }

  http = createServer((req, res) => {
    handler(req, res).catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('sse fake handler error', err)
      try {
        if (!res.headersSent) {
          res.statusCode = 500
          res.end()
        }
      } catch {
        // socket already closed
      }
    })
  })

  http.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const address = http.address()
  if (!address || typeof address === 'string') {
    throw new Error('failed to bind sse fake server')
  }
  const sseUrl = `http://127.0.0.1:${address.port}/sse`

  return {
    url: sseUrl,
    close: async () => {
      for (const t of transports.values()) await t.close().catch(() => {})
      await new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy()
        http.close(() => resolve())
      })
    },
    dropConnections: () => {
      for (const s of sockets) s.destroy()
      sockets.clear()
    },
  }
}

/* ---------- helpers ---------- */

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
