import { createServer } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { RealtimeClient } from './voice/index.js'
import { Orchestrator } from './agent/Orchestrator.js'
import { createLlmClient } from './llm/client.js'
import type { ServerEvent } from './events.js'
import { McpServer, parseJsonRpcRequest } from './mcp/server.js'
import { createMcpAdapter } from './mcp/adapter.js'
import bonjour from 'bonjour'

const PROVIDER = process.env.LLM_PROVIDER ?? 'openai'
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? ''
const HOST = process.env.HELPER_HOST ?? '127.0.0.1'
const PORT = Number(process.env.HELPER_PORT ?? process.env.PORT ?? '4317')

// ─── Event broadcast bus ───────────────────────────────────────────────────────
// All connected WebSocket clients and active SSE streams receive these events.

/** WS clients that want full state + incremental events. */
const wsClients = new Set<WebSocket>()

/**
 * Active SSE response generators keyed by session/run identifier.
 * Each entry yields ServerEvents formatted as SSE data frames.
 */
const sseStreams = new Map<string, (event: ServerEvent) => void>()

function broadcast(event: ServerEvent) {
  const payload = JSON.stringify(event)
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload)
  }
  // Also deliver to all active SSE streams
  for (const emit of sseStreams.values()) {
    emit(event)
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sendSSE(res: import('node:http').ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

// ─── App ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Nessie starting... (LLM: ${PROVIDER})`)

  let llm = null
  try {
    llm = createLlmClient()
  } catch (error) {
    console.warn(`Warning: chat LLM unavailable — ${error instanceof Error ? error.message : String(error)}`)
  }

  const orchestrator = new Orchestrator({
    defaultAgent: 'main',
    llm: llm ?? undefined,
    callbacks: {
      onBroadcast: broadcast,
      onStateChange: (state) => {
        console.debug('[state]', state.agents.length, 'agents,', state.messages.length, 'messages')
      },
    },
  })

  // ─── MCP server ────────────────────────────────────────────────────────────

  const mcpAdapter = createMcpAdapter(orchestrator)
  const mcpServer = new McpServer(mcpAdapter)

  // ─── MDNS / Bonjour advertisement ─────────────────────────────────────────

  const mdns = bonjour()
  mdns.publish({ name: 'Nessie', type: '_nessie._tcp', port: PORT })
  console.log(`mDNS: advertising _nessie._tcp on port ${PORT}`)

  // ─── HTTP server ────────────────────────────────────────────────────────────

  const server = createServer(async (req, res) => {
    // ─── GET /health ──────────────────────────────────────────────────────────
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, llmConfigured: llm !== null }))
      return
    }

    // ─── GET /state ──────────────────────────────────────────────────────────
    if (req.method === 'GET' && req.url === '/state') {
      const state = orchestrator.getState()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(state))
      return
    }

    // ─── POST /chat (SSE streaming) ──────────────────────────────────────────
    if (req.method === 'POST' && (req.url === '/chat' || req.url?.startsWith('/chat'))) {
      // Read body
      const chunks: Buffer[] = []
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }
      const rawBody = Buffer.concat(chunks).toString('utf8')
      type ChatBody = { message?: unknown; targetAgentId?: unknown; threadId?: unknown }
      const body = rawBody ? JSON.parse(rawBody) as ChatBody : {}
      const message = typeof body.message === 'string' ? body.message.trim() : ''
      const threadId = typeof body.threadId === 'string' ? body.threadId.trim() : 'main'

      if (!message) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'message is required' }))
        return
      }

      // Set SSE headers — X-Accel-Buffering disables nginx buffering
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      })

      // Generate a unique stream ID so the client can match events
      const streamId = `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`

      // Register this SSE stream so broadcast() can reach it
      const emit: typeof sseStreams extends Map<string, infer V> ? V : never = (event: ServerEvent) => {
        // Map server event types to SSE event names
        switch (event.type) {
          case 'streaming.start':
            sendSSE(res, 'start', { runId: event.runId, threadId: event.threadId })
            break
          case 'streaming.delta':
            sendSSE(res, 'delta', { content: event.content })
            break
          case 'streaming.done':
            sendSSE(res, 'done', { content: event.content, runId: event.runId })
            break
          case 'message':
            sendSSE(res, 'message', event.message)
            break
          case 'subagent.started':
            sendSSE(res, 'subagent.started', event.subAgent)
            break
          case 'subagent.done':
            sendSSE(res, 'subagent.done', { subAgentId: event.subAgentId, result: event.result })
            break
          case 'tool.called':
            sendSSE(res, 'tool.called', { name: event.name, input: event.input })
            break
          case 'tool.done':
            sendSSE(res, 'tool.done', { name: event.name })
            break
          case 'agent.wake':
            sendSSE(res, 'agent.wake', { agentId: event.agentId, reason: event.reason })
            break
          case 'task.created':
            sendSSE(res, 'task.created', event.task)
            break
          case 'task.state_changed':
            sendSSE(res, 'task.state_changed', {
              taskId: event.taskId, fromStatus: event.fromStatus,
              toStatus: event.toStatus, reason: event.reason,
            })
            break
          case 'error':
            sendSSE(res, 'error', { message: event.message })
            break
        }
      }
      sseStreams.set(streamId, emit)

      // Send streaming start event immediately
      sendSSE(res, 'start', { streamId, message: message.slice(0, 80) })

      // streamResponse handles routing + pushes user message to state + broadcasts it.
      // Nothing needed here — just stream the response deltas.
      try {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of orchestrator.streamResponse(message, threadId)) {
          // nothing to yield — broadcast handles SSE delivery
        }
      } catch (error) {
        emit({ type: 'error', message: error instanceof Error ? error.message : String(error) })
      } finally {
        sendSSE(res, 'end', {})
        sseStreams.delete(streamId)
      }
      return
    }

    // ─── POST /chat (non-streaming, JSON) ────────────────────────────────────
    if (req.method === 'POST' && req.url === '/chat/sync') {
      const chunks: Buffer[] = []
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }
      const rawBody = Buffer.concat(chunks).toString('utf8')
      const body = rawBody ? JSON.parse(rawBody) as { message?: unknown; targetAgentId?: unknown } : {}
      const message = typeof body.message === 'string' ? body.message.trim() : ''
      const targetAgentId = typeof body.targetAgentId === 'string' ? body.targetAgentId.trim() : 'main'

      if (!message) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'message is required' }))
        return
      }

      try {
        const reply = await orchestrator.handleUserMessage(message, targetAgentId || 'main')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ reply }))
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      }
      return
    }

    // ─── MCP endpoint (JSON-RPC 2.0) ──────────────────────────────────────
    if ((req.method === 'POST' || req.method === 'GET') && (req.url === '/mcp' || req.url?.startsWith('/mcp'))) {
      // GET /mcp → tool manifest
      if (req.method === 'GET') {
        const toolsResult = await mcpServer.handleRequest({ jsonrpc: '2.0', id: null, method: 'tools/list' })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        const mcpResult = toolsResult.result as Record<string, unknown> | undefined
        res.end(JSON.stringify({ tools: mcpResult?.tools ?? [] }))
        return
      }

      const chunks: Buffer[] = []
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }
      const body = Buffer.concat(chunks).toString('utf8')

      const requests = parseJsonRpcRequest(body)
      const responses = await Promise.all(requests.map((r) => mcpServer.handleRequest(r)))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(responses.length === 1 ? responses[0] : responses))
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  })

  // ─── WebSocket server ───────────────────────────────────────────────────────

  const wss = new WebSocketServer({ server })

  wss.on('connection', (ws, req) => {
    const path = req.url ?? ''

    if (path === '/voice' || path.startsWith('/voice')) {
      handleVoiceWebSocket(ws)
      return
    }

    // Default: state + event client
    wsClients.add(ws)
    console.log('[ws] client connected (total:', wsClients.size, ')')

    // Send current full state on connect
    const state = orchestrator.getState()
    ws.send(JSON.stringify({ type: 'state', data: state }))

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type?: string; [key: string]: unknown }
        // Client → Server events (optional acknowledgements, subscriptions)
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }))
      } catch {
        // ignore
      }
    })

    ws.on('close', () => {
      wsClients.delete(ws)
      console.log('[ws] client disconnected (total:', wsClients.size, ')')
    })

    ws.on('error', (err) => {
      console.error('[ws] error:', err.message)
    })
  })

  // ─── Voice WebSocket handler ─────────────────────────────────────────────────
  // macOS sends JSON control messages; backend streams transcription + response back.

  function handleVoiceWebSocket(ws: WebSocket) {
    console.log('[voice] client connected')

    // Route to the existing RealtimeClient if available, otherwise use orchestrator
    // For now: echo transcript → orchestrator → stream response back
    let sessionId: string | null = null
    let transcriptBuffer = ''

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>
        switch (msg.type) {
          case 'start': {
            sessionId = String(msg.sessionId ?? Date.now())
            ws.send(JSON.stringify({ type: 'session_started', sessionId }))
            console.log('[voice] session started:', sessionId)
            break
          }
          case 'transcript': {
            // Client sent partial transcript text
            transcriptBuffer = String(msg.text ?? '')
            ws.send(JSON.stringify({ type: 'transcript', text: transcriptBuffer }))
            break
          }
          case 'audio_level': {
            // Client sending audio level for VAD detection
            // Could be used for push-to-talk VAD here
            break
          }
          case 'stop': {
            // End of speech — process transcript
            if (transcriptBuffer.trim()) {
              processTranscript(ws, transcriptBuffer.trim())
            }
            transcriptBuffer = ''
            ws.send(JSON.stringify({ type: 'session_ended' }))
            break
          }
        }
      } catch {
        // ignore parse errors
      }
    })

    ws.on('close', () => {
      console.log('[voice] client disconnected')
    })

    ws.on('error', (err) => {
      console.error('[voice] error:', err.message)
    })
  }

  async function processTranscript(ws: WebSocket, text: string) {
    console.log('[voice] processing:', text.slice(0, 80))
    ws.send(JSON.stringify({ type: 'transcript', text }))

    try {
      // Stream response via orchestrator and relay deltas
      let fullResponse = ''
      for await (const delta of orchestrator.streamResponse(text, 'voice')) {
        fullResponse += delta
        ws.send(JSON.stringify({ type: 'response_delta', delta }))
      }
      ws.send(JSON.stringify({ type: 'response_done', content: fullResponse }))
    } catch (error) {
      ws.send(JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : String(error) }))
    }
  }

  // ─── Start ─────────────────────────────────────────────────────────────────

  server.listen(PORT, HOST, () => {
    console.log(`HTTP: listening on http://${HOST}:${PORT}`)
    console.log(`WS:   listening on ws://${HOST}:${PORT}`)
  })

  // ─── Voice layer (OpenAI Realtime) ──────────────────────────────────────────

  if (!OPENAI_API_KEY) {
    console.warn('Warning: OPENAI_API_KEY not set — voice layer disabled')
  } else {
    const voiceClient = new RealtimeClient({
      apiKey: OPENAI_API_KEY,
      model: 'gpt-realtime-1.5',
      callbacks: {
        onTranscript: async (text) => {
          if (!text.trim()) return
          console.log('User said:', text)
          const response = await orchestrator.handleUserMessage(text)
          console.log('Agent:', response.slice(0, 80))
        },
        onConnected: () => console.log('Voice: connected'),
        onDisconnected: () => console.log('Voice: disconnected'),
        onError: (err) => console.error('Voice error:', err),
      },
    })
    await voiceClient.connect()
  }

  console.log('Ready. POST /chat (SSE) or /chat/sync (JSON), GET /state, GET /health, WS on same port.')

  // ─── Shutdown ──────────────────────────────────────────────────────────────

  const shutdown = () => {
    for (const ws of wsClients) ws.close()
    wsClients.clear()
    sseStreams.clear()
    mdns.destroy()
    server.close()
    orchestrator.close()
    llm?.close()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch(console.error)
