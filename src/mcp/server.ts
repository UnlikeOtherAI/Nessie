/**
 * MCP (Model Context Protocol) server for Helper Agent.
 *
 * Exposes all app actions as MCP tools: send_message, list_sessions,
 * get_state, invoke_tool, voice_start, voice_stop.
 *
 * Protocol: JSON-RPC 2.0 over HTTP POST /mcp.
 */

import type { ServerEvent } from '../events.js'

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS: ToolDef[] = [
  {
    name: 'send_message',
    description: 'Send a chat message and stream the response.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The message to send' },
        threadId: { type: 'string', description: 'Target thread ID (defaults to main)', },
      },
      required: ['message'],
    },
  },
  {
    name: 'list_sessions',
    description: 'List all conversation sessions.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_state',
    description: 'Get the current orchestrator state.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'invoke_tool',
    description: 'Invoke a named tool directly.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Tool name (Bash, FileRead, etc.)' },
        input: { type: 'object', description: 'Tool arguments' },
      },
      required: ['name'],
    },
  },
  {
    name: 'voice_start',
    description: 'Start a voice session.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'voice_stop',
    description: 'Stop the active voice session.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'screenshot',
    description: 'Take a screenshot of the screen. Returns a base64-encoded PNG image.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Optional output file path. If omitted, returns base64-encoded image.' },
      },
    },
  },
  {
    name: 'list_messages',
    description: 'List messages from a thread with pagination.',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string', description: 'Thread ID to list messages from. Defaults to main.' },
        limit: { type: 'number', description: 'Maximum messages to return (default 50, max 200).' },
        offset: { type: 'number', description: 'Number of messages to skip for pagination (default 0).' },
        direction: { type: 'string', description: '"older" (default) or "newer" — direction to paginate from cursor.' },
      },
    },
  },
  {
    name: 'inject_message',
    description: 'Inject a message into a thread without triggering a response. Useful for logging, system messages, or pre-loading conversation context.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'Message role: "user", "assistant", or "system".' },
        content: { type: 'string', description: 'The message content.' },
        threadId: { type: 'string', description: 'Thread ID to inject into (defaults to main).' },
      },
      required: ['role', 'content'],
    },
  },
]

interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

// ─── MCP JSON-RPC types ──────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number | string | null
  method: string
  params?: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

// ─── MCP Server ─────────────────────────────────────────────────────────────

export class McpServer {
  private orchestrator: McpOrchestrator

  constructor(orchestrator: McpOrchestrator) {
    this.orchestrator = orchestrator
  }

  // ─── Handle incoming JSON-RPC request ───────────────────────────────────

  async handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    try {
      switch (req.method) {
        case 'tools/list':
          return this.listTools(req)
        case 'tools/call':
          return await this.callTool(req)
        case 'resources/list':
          return this.listResources(req)
        case 'initialize':
          return this.initialize(req)
        case 'notifications/initialized':
          return { jsonrpc: '2.0', id: req.id ?? null }
        default:
          return { jsonrpc: '2.0', id: req.id ?? null, error: { code: -32601, message: `Method not found: ${req.method}` } }
      }
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id: req.id ?? null,
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : String(err),
        },
      }
    }
  }

  // ─── Protocol methods ─────────────────────────────────────────────────

  private initialize(req: JsonRpcRequest): JsonRpcResponse {
    return {
      jsonrpc: '2.0',
      id: req.id ?? null,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'helper-agent', version: '1.0.0' },
      },
    }
  }

  private listTools(req: JsonRpcRequest): JsonRpcResponse {
    return {
      jsonrpc: '2.0',
      id: req.id ?? null,
      result: {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      },
    }
  }

  private async callTool(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const params = req.params as { name?: string; arguments?: Record<string, unknown> } | undefined
    const name = params?.name as string | undefined
    const args = params?.arguments ?? {}

    if (!name) {
      return { jsonrpc: '2.0', id: req.id ?? null, error: { code: -32602, message: 'Missing tool name' } }
    }

    // Handle send_message — streams response back via orchestrator
    if (name === 'send_message') {
      const message = args.message as string | undefined
      const threadId = (args.threadId as string | undefined) ?? 'main'
      if (!message) {
        return { jsonrpc: '2.0', id: req.id ?? null, error: { code: -32602, message: 'message is required' } }
      }
      // Collect streaming deltas
      let response = ''
      try {
        for await (const delta of this.orchestrator.streamResponse(message, threadId)) {
          response += delta
        }
      } catch (err) {
        response = `Error: ${err instanceof Error ? err.message : String(err)}`
      }
      return { jsonrpc: '2.0', id: req.id ?? null, result: { content: [{ type: 'text', text: response || '(no response)' }] } }
    }

    // Handle screenshot directly — uses macOS screencapture
    if (name === 'screenshot') {
      const { readFileSync } = await import('fs')
      const { execFileSync } = await import('child_process')
      const outPath = args.path as string | undefined
      const tmpPath = '/tmp/helper-screenshot.png'
      try {
        if (outPath) {
          execFileSync('screencapture', [outPath])
          return { jsonrpc: '2.0', id: req.id ?? null, result: { content: [{ type: 'text', text: `Screenshot saved to ${outPath}` }] } }
        } else {
          execFileSync('screencapture', ['-x', tmpPath])
          const buf = readFileSync(tmpPath)
          const b64 = buf.toString('base64')
          return { jsonrpc: '2.0', id: req.id ?? null, result: { content: [{ type: 'image', data: b64, mimeType: 'image/png' }] } }
        }
      } catch (err) {
        return { jsonrpc: '2.0', id: req.id ?? null, error: { code: -32603, message: String(err) } }
      }
    }

    // Handle inject_message
    if (name === 'inject_message') {
      const role = args.role as string
      const content = args.content as string
      const threadId = (args.threadId as string | undefined) ?? 'main'
      if (!role || !content) {
        return { jsonrpc: '2.0', id: req.id ?? null, error: { code: -32602, message: 'role and content are required' } }
      }
      if (role !== 'user' && role !== 'assistant' && role !== 'system') {
        return { jsonrpc: '2.0', id: req.id ?? null, error: { code: -32602, message: 'role must be user, assistant, or system' } }
      }
      this.orchestrator.pushMessage({ role: role as 'user' | 'assistant' | 'system', threadId, content })
      return { jsonrpc: '2.0', id: req.id ?? null, result: { content: [{ type: 'text', text: `Injected ${role} message into ${threadId}.` }] } }
    }

    // Handle list_messages
    if (name === 'list_messages') {
      const result = this.orchestrator.listMessages({
        threadId: args.threadId as string | undefined,
        limit: typeof args.limit === 'number' ? Math.min(Math.floor(args.limit), 200) : 50,
        offset: typeof args.offset === 'number' ? Math.floor(args.offset) : 0,
        direction: args.direction as 'older' | 'newer' | undefined,
      })
      return { jsonrpc: '2.0', id: req.id ?? null, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } }
    }

    // Handle list_sessions — structured JSON
    if (name === 'list_sessions') {
      const state = this.orchestrator.getState()
      // Derive sessions from messages grouped by threadId
      const byThread = new Map<string, { count: number; lastMsg: MessageForMcp }>()
      const allMessages = state.messages ?? []
      for (const msg of allMessages) {
        const existing = byThread.get(msg.threadId)
        if (!existing || msg.timestamp > existing.lastMsg.timestamp) {
          byThread.set(msg.threadId, { count: (existing?.count ?? 0) + 1, lastMsg: msg })
        }
      }
      const sessions = Array.from(byThread.entries()).map(([id, info]) => ({
        id,
        name: id === 'main' ? 'Main Chat' : (info.lastMsg.content ?? '').slice(0, 60),
        messageCount: info.count,
        lastMessage: { role: info.lastMsg.role, content: info.lastMsg.content, timestamp: info.lastMsg.timestamp },
      }))
      return { jsonrpc: '2.0', id: req.id ?? null, result: { content: [{ type: 'text', text: JSON.stringify({ sessions }, null, 2) }] } }
    }

    const result = await this.orchestrator.callTool(name, args)
    return { jsonrpc: '2.0', id: req.id ?? null, result: { content: [{ type: 'text', text: String(result) }] } }
  }

  private listResources(req: JsonRpcRequest): JsonRpcResponse {
    const state = this.orchestrator.getState()
    return {
      jsonrpc: '2.0',
      id: req.id ?? null,
      result: {
        resources: [
          { uri: 'helper://state', name: 'Orchestrator State', mimeType: 'application/json', description: 'Current agent/session state' },
          { uri: 'helper://sessions', name: 'Sessions', mimeType: 'application/json', description: 'All conversation sessions' },
          { uri: 'helper://agents', name: 'Agents', mimeType: 'application/json', description: 'Active agents' },
        ],
      },
    }
  }
}

// ─── Orchestrator interface exposed to MCP ───────────────────────────────────

export interface McpOrchestrator {
  getState(): OrchestratorStateForMcp
  listMessages(opts: ListMessagesOptions): ListMessagesResult
  callTool(name: string, args: Record<string, unknown>): Promise<string>
  pushMessage(input: { role: 'user' | 'assistant' | 'system'; threadId: string; content: string }): void
  sendMessage(message: string, threadId: string): Promise<string>
  streamResponse(message: string, threadId: string): AsyncGenerator<string, void, undefined>
}

export interface ListMessagesOptions {
  threadId?: string
  limit?: number
  offset?: number
  direction?: 'older' | 'newer'
}

export interface ListMessagesResult {
  messages: MessageForMcp[]
  total: number
  hasMore: boolean
}

export interface MessageForMcp {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  threadId: string
  timestamp: number
}

export interface OrchestratorStateForMcp {
  agents: { id: string; name: string; type: string; trigger: string }[]
  messages: MessageForMcp[]
  sessions: { id: string; name: string; messageCount: number }[]
  isListening: boolean
  isSpeaking: boolean
}

// ─── Parse body into JSON-RPC request ──────────────────────────────────────

export function parseJsonRpcRequest(body: string): JsonRpcRequest[] {
  const parsed = JSON.parse(body)
  return Array.isArray(parsed) ? parsed : [parsed]
}
