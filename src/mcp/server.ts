/**
 * MCP (Model Context Protocol) server for Nessie.
 *
 * Exposes all app actions as MCP tools: send_message, list_sessions,
 * get_state, invoke_tool, voice_start, voice_stop.
 *
 * Protocol: JSON-RPC 2.0 over HTTP POST /mcp.
 */

import { CreateTaskSchema, SpawnRequestSchema } from '../orchestration/task-types.js'

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
    description: 'Inject a message into a thread without triggering a response.'
      + ' Useful for logging, system messages, or pre-loading conversation context.',
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
  {
    name: 'create_task',
    description: 'Create a new task in the orchestration ledger.',
    inputSchema: {
      type: 'object',
      properties: {
        role: {
          type: 'string',
          description: 'Task role: orchestrator, builder, reviewer, watcher, researcher, debugger',
        },
        label: { type: 'string', description: 'Human-readable task description' },
        parentId: { type: 'string', description: 'Parent task ID (for child tasks)' },
        threadId: { type: 'string', description: 'Thread ID (defaults to main)' },
        assignedModel: { type: 'string', description: 'Model override for this task' },
        timeoutSeconds: { type: 'number', description: 'Timeout in seconds' },
      },
      required: ['role', 'label'],
    },
  },
  {
    name: 'list_tasks',
    description: 'List tasks from the orchestration ledger, optionally filtered by status.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Filter by status: inbox, assigned, in_progress, review,'
            + ' done, failed, cancelled, awaiting_approval',
        },
      },
    },
  },
  {
    name: 'get_task',
    description: 'Get task details including event history.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task ID' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'transition_task',
    description: 'Change a task status. Valid transitions:'
      + ' inbox->assigned/cancelled, assigned->in_progress/cancelled,'
      + ' in_progress->review/failed/cancelled/awaiting_approval,'
      + ' review->done/in_progress/failed, failed->inbox,'
      + ' awaiting_approval->in_progress/cancelled.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task ID' },
        status: { type: 'string', description: 'Target status' },
        reason: { type: 'string', description: 'Reason for the transition' },
      },
      required: ['taskId', 'status', 'reason'],
    },
  },
  {
    name: 'spawn_task',
    description: 'Spawn a child task. Returns immediately with task ID. Non-blocking.',
    inputSchema: {
      type: 'object',
      properties: {
        parentTaskId: { type: 'string', description: 'Parent task ID' },
        role: { type: 'string', description: 'Task role' },
        label: { type: 'string', description: 'Task description' },
        toolScope: {
          type: 'array',
          items: { type: 'string' },
          description: 'Allowed tools',
        },
        timeoutSeconds: { type: 'number', description: 'Timeout in seconds (default 300)' },
        modelOverride: { type: 'string', description: 'Model override' },
      },
      required: ['parentTaskId', 'role', 'label'],
    },
  },
  {
    name: 'get_spawn_status',
    description: 'Get current spawn status (active count, limit).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'submit_review',
    description: 'Submit a pass/fail review for a task in review status.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task ID to review' },
        verdict: {
          type: 'string',
          description: 'Review verdict: pass or fail',
        },
        reason: { type: 'string', description: 'Reason for the verdict' },
        reviewerTaskId: {
          type: 'string',
          description: 'ID of the reviewer task performing the review',
        },
        repairInstructions: {
          type: 'string',
          description: 'Instructions for repair (required for fail verdict)',
        },
      },
      required: ['taskId', 'verdict', 'reason'],
    },
  },
  {
    name: 'get_review_history',
    description: 'Get review history for a task.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task ID' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'list_roles',
    description: 'List all roles with their tool policies.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'request_approval',
    description: 'Request approval for a task in awaiting_approval status.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task ID' },
        reason: { type: 'string', description: 'Why approval is needed' },
        requestedBy: { type: 'string', description: 'ID of requesting task' },
      },
      required: ['taskId', 'reason'],
    },
  },
  {
    name: 'approve_task',
    description: 'Approve a pending approval request. Task resumes.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task ID to approve' },
        resolvedBy: { type: 'string', description: 'Who approved' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'reject_task',
    description: 'Reject a pending approval request. Task is cancelled.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task ID to reject' },
        resolvedBy: { type: 'string', description: 'Who rejected' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'list_pending_approvals',
    description: 'List all tasks awaiting approval.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'run_validators',
    description: 'Run lint + typecheck validators against the project.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task ID to validate' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'get_metrics',
    description: 'Get aggregate orchestration metrics.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_task_metrics',
    description: 'Get metrics for a specific task.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task ID' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'get_alerts',
    description: 'Get watcher alerts (stale tasks, loops, runaway spawns).',
    inputSchema: { type: 'object', properties: {} },
  },
  // ── OpenClaw interop ──────────────────────────────────────────────────────
  {
    name: 'openclaw_export_state',
    description: 'Export orchestration state in OpenClaw-compatible format (sessions + agent configs).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'openclaw_agent_configs',
    description: 'Get all Nessie role policies as OpenClaw agent configurations.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'openclaw_session_key',
    description: 'Get the OpenClaw session key for a Nessie task.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Nessie task ID' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'openclaw_resolve_key',
    description: 'Resolve an OpenClaw session key to a Nessie task.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionKey: { type: 'string', description: 'OpenClaw session key' },
      },
      required: ['sessionKey'],
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
          return {
            jsonrpc: '2.0', id: req.id ?? null,
            error: { code: -32601, message: `Method not found: ${req.method}` },
          }
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
      return {
        jsonrpc: '2.0', id: req.id ?? null,
        error: { code: -32602, message: 'Missing tool name' },
      }
    }

    // Handle send_message — streams response back via orchestrator
    if (name === 'send_message') {
      const message = args.message as string | undefined
      const threadId = (args.threadId as string | undefined) ?? 'main'
      if (!message) {
        return {
          jsonrpc: '2.0', id: req.id ?? null,
          error: { code: -32602, message: 'message is required' },
        }
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
      return {
        jsonrpc: '2.0', id: req.id ?? null,
        result: { content: [{ type: 'text', text: response || '(no response)' }] },
      }
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
          return {
            jsonrpc: '2.0', id: req.id ?? null,
            result: { content: [{ type: 'text', text: `Screenshot saved to ${outPath}` }] },
          }
        } else {
          execFileSync('screencapture', ['-x', tmpPath])
          const buf = readFileSync(tmpPath)
          const b64 = buf.toString('base64')
          return {
            jsonrpc: '2.0', id: req.id ?? null,
            result: { content: [{ type: 'image', data: b64, mimeType: 'image/png' }] },
          }
        }
      } catch (err) {
        return {
          jsonrpc: '2.0', id: req.id ?? null,
          error: { code: -32603, message: String(err) },
        }
      }
    }

    // Handle inject_message
    if (name === 'inject_message') {
      const role = args.role as string
      const content = args.content as string
      const threadId = (args.threadId as string | undefined) ?? 'main'
      if (!role || !content) {
        return {
          jsonrpc: '2.0', id: req.id ?? null,
          error: { code: -32602, message: 'role and content are required' },
        }
      }
      if (role !== 'user' && role !== 'assistant' && role !== 'system') {
        return {
          jsonrpc: '2.0', id: req.id ?? null,
          error: { code: -32602, message: 'role must be user, assistant, or system' },
        }
      }
      this.orchestrator.pushMessage({ role: role as 'user' | 'assistant' | 'system', threadId, content })
      return {
        jsonrpc: '2.0', id: req.id ?? null,
        result: { content: [{ type: 'text', text: `Injected ${role} message into ${threadId}.` }] },
      }
    }

    // Handle list_messages
    if (name === 'list_messages') {
      const result = this.orchestrator.listMessages({
        threadId: args.threadId as string | undefined,
        limit: typeof args.limit === 'number' ? Math.min(Math.floor(args.limit), 200) : 50,
        offset: typeof args.offset === 'number' ? Math.floor(args.offset) : 0,
        direction: args.direction as 'older' | 'newer' | undefined,
      })
      return {
        jsonrpc: '2.0', id: req.id ?? null,
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
      }
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
        lastMessage: {
          role: info.lastMsg.role, content: info.lastMsg.content, timestamp: info.lastMsg.timestamp,
        },
      }))
      return {
        jsonrpc: '2.0', id: req.id ?? null,
        result: { content: [{ type: 'text', text: JSON.stringify({ sessions }, null, 2) }] },
      }
    }

    // Handle create_task
    if (name === 'create_task') {
      const parsed = CreateTaskSchema.safeParse({
        role: args.role,
        label: args.label,
        parentId: args.parentId ?? null,
        threadId: args.threadId ?? 'main',
        assignedModel: args.assignedModel ?? null,
        timeoutSeconds: typeof args.timeoutSeconds === 'number' ? args.timeoutSeconds : null,
        specPath: null,
        outputPath: null,
      })
      if (!parsed.success) {
        return {
          jsonrpc: '2.0', id: req.id ?? null,
          error: { code: -32602, message: parsed.error.message },
        }
      }
      const task = this.orchestrator.createTask(parsed.data)
      return {
        jsonrpc: '2.0', id: req.id ?? null,
        result: { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] },
      }
    }

    // Handle list_tasks
    if (name === 'list_tasks') {
      const status = args.status as string | undefined
      const tasks = this.orchestrator.getTasks(status)
      return {
        jsonrpc: '2.0', id: req.id ?? null,
        result: { content: [{ type: 'text', text: JSON.stringify(tasks, null, 2) }] },
      }
    }

    // Handle get_task
    if (name === 'get_task') {
      const taskId = args.taskId as string
      if (!taskId) {
        return {
          jsonrpc: '2.0', id: req.id ?? null,
          error: { code: -32602, message: 'taskId is required' },
        }
      }
      const result = this.orchestrator.getTask(taskId)
      return {
        jsonrpc: '2.0', id: req.id ?? null,
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
      }
    }

    // Handle transition_task
    if (name === 'transition_task') {
      const taskId = args.taskId as string
      const status = args.status as string
      const reason = args.reason as string
      if (!taskId || !status || !reason) {
        return {
          jsonrpc: '2.0', id: req.id ?? null,
          error: { code: -32602, message: 'taskId, status, and reason are required' },
        }
      }
      const task = this.orchestrator.transitionTask(taskId, status, reason)
      return {
        jsonrpc: '2.0', id: req.id ?? null,
        result: { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] },
      }
    }

    // Handle spawn_task
    if (name === 'spawn_task') {
      const parsed = SpawnRequestSchema.safeParse({
        parentTaskId: args.parentTaskId,
        role: args.role,
        label: args.label,
        toolScope: args.toolScope,
        timeoutSeconds: args.timeoutSeconds,
        modelOverride: args.modelOverride,
      })
      if (!parsed.success) {
        return {
          jsonrpc: '2.0', id: req.id ?? null,
          error: { code: -32602, message: parsed.error.message },
        }
      }
      const spawnResult = this.orchestrator.spawnTask({
        parentTaskId: parsed.data.parentTaskId ?? '',
        role: parsed.data.role,
        label: parsed.data.label,
        toolScope: parsed.data.toolScope,
        timeoutSeconds: parsed.data.timeoutSeconds,
        modelOverride: parsed.data.modelOverride,
      })
      return {
        jsonrpc: '2.0', id: req.id ?? null,
        result: { content: [{ type: 'text', text: JSON.stringify(spawnResult, null, 2) }] },
      }
    }

    // Handle get_spawn_status
    if (name === 'get_spawn_status') {
      const status = this.orchestrator.getSpawnStatus()
      return {
        jsonrpc: '2.0', id: req.id ?? null,
        result: { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] },
      }
    }

    // Handle submit_review
    if (name === 'submit_review') {
      const taskId = args.taskId as string
      const verdict = args.verdict as string
      const reason = args.reason as string
      const reviewerTaskId = args.reviewerTaskId as string | undefined
      const repairInstructions = args.repairInstructions as string | undefined
      if (!taskId || !verdict || !reason) {
        return {
          jsonrpc: '2.0', id: req.id ?? null,
          error: { code: -32602, message: 'taskId, verdict, and reason are required' },
        }
      }
      if (verdict !== 'pass' && verdict !== 'fail') {
        return {
          jsonrpc: '2.0', id: req.id ?? null,
          error: { code: -32602, message: 'verdict must be pass or fail' },
        }
      }
      if (verdict === 'fail' && !repairInstructions) {
        return {
          jsonrpc: '2.0', id: req.id ?? null,
          error: {
            code: -32602,
            message: 'repairInstructions required when verdict is fail',
          },
        }
      }
      const review = this.orchestrator.submitReview(
        taskId, verdict, reason, reviewerTaskId, repairInstructions,
      )
      return {
        jsonrpc: '2.0', id: req.id ?? null,
        result: { content: [{ type: 'text', text: JSON.stringify(review, null, 2) }] },
      }
    }

    // Handle get_review_history
    if (name === 'get_review_history') {
      const taskId = args.taskId as string
      if (!taskId) {
        return {
          jsonrpc: '2.0', id: req.id ?? null,
          error: { code: -32602, message: 'taskId is required' },
        }
      }
      const history = this.orchestrator.getReviewHistory(taskId)
      return {
        jsonrpc: '2.0', id: req.id ?? null,
        result: { content: [{ type: 'text', text: JSON.stringify(history, null, 2) }] },
      }
    }

    // Handle list_roles
    if (name === 'list_roles') {
      const roles = this.orchestrator.getRolePolicies()
      return {
        jsonrpc: '2.0', id: req.id ?? null,
        result: { content: [{ type: 'text', text: JSON.stringify(roles, null, 2) }] },
      }
    }

    // Handle request_approval
    if (name === 'request_approval') {
      const taskId = args.taskId as string
      const reason = args.reason as string
      const requestedBy = args.requestedBy as string | undefined
      if (!taskId || !reason) {
        return {
          jsonrpc: '2.0', id: req.id ?? null,
          error: { code: -32602, message: 'taskId and reason are required' },
        }
      }
      const approval = this.orchestrator.requestApproval(
        taskId, reason, requestedBy,
      )
      return {
        jsonrpc: '2.0', id: req.id ?? null,
        result: {
          content: [{ type: 'text', text: JSON.stringify(approval, null, 2) }],
        },
      }
    }

    // Handle approve_task
    if (name === 'approve_task') {
      const taskId = args.taskId as string
      const resolvedBy = args.resolvedBy as string | undefined
      if (!taskId) {
        return {
          jsonrpc: '2.0', id: req.id ?? null,
          error: { code: -32602, message: 'taskId is required' },
        }
      }
      const approval = this.orchestrator.approveTask(taskId, resolvedBy)
      return {
        jsonrpc: '2.0', id: req.id ?? null,
        result: {
          content: [{ type: 'text', text: JSON.stringify(approval, null, 2) }],
        },
      }
    }

    // Handle reject_task
    if (name === 'reject_task') {
      const taskId = args.taskId as string
      const resolvedBy = args.resolvedBy as string | undefined
      if (!taskId) {
        return {
          jsonrpc: '2.0', id: req.id ?? null,
          error: { code: -32602, message: 'taskId is required' },
        }
      }
      const approval = this.orchestrator.rejectTask(taskId, resolvedBy)
      return {
        jsonrpc: '2.0', id: req.id ?? null,
        result: {
          content: [{ type: 'text', text: JSON.stringify(approval, null, 2) }],
        },
      }
    }

    // Handle list_pending_approvals
    if (name === 'list_pending_approvals') {
      const approvals = this.orchestrator.listPendingApprovals()
      return {
        jsonrpc: '2.0', id: req.id ?? null,
        result: {
          content: [{ type: 'text', text: JSON.stringify(approvals, null, 2) }],
        },
      }
    }

    // Handle run_validators
    if (name === 'run_validators') {
      const taskId = args.taskId as string
      if (!taskId) {
        return {
          jsonrpc: '2.0', id: req.id ?? null,
          error: { code: -32602, message: 'taskId is required' },
        }
      }
      const results = await this.orchestrator.runValidators(taskId)
      return {
        jsonrpc: '2.0', id: req.id ?? null,
        result: {
          content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
        },
      }
    }

    // Handle get_metrics
    if (name === 'get_metrics') {
      const metrics = this.orchestrator.getMetrics()
      return {
        jsonrpc: '2.0', id: req.id ?? null,
        result: {
          content: [{ type: 'text', text: JSON.stringify(metrics, null, 2) }],
        },
      }
    }

    // Handle get_task_metrics
    if (name === 'get_task_metrics') {
      const taskId = args.taskId as string
      if (!taskId) {
        return {
          jsonrpc: '2.0', id: req.id ?? null,
          error: { code: -32602, message: 'taskId is required' },
        }
      }
      const metrics = this.orchestrator.getTaskMetrics(taskId)
      return {
        jsonrpc: '2.0', id: req.id ?? null,
        result: {
          content: [{ type: 'text', text: JSON.stringify(metrics, null, 2) }],
        },
      }
    }

    // Handle get_alerts
    if (name === 'get_alerts') {
      const alerts = this.orchestrator.getAlerts()
      return {
        jsonrpc: '2.0', id: req.id ?? null,
        result: {
          content: [{ type: 'text', text: JSON.stringify(alerts, null, 2) }],
        },
      }
    }

    // ── OpenClaw interop tools ──────────────────────────────────────────────
    if (name === 'openclaw_export_state') {
      const state = this.orchestrator.exportOpenClawState()
      return {
        jsonrpc: '2.0', id: req.id ?? null,
        result: {
          content: [{ type: 'text', text: JSON.stringify(state, null, 2) }],
        },
      }
    }
    if (name === 'openclaw_agent_configs') {
      const configs = this.orchestrator.getOpenClawAgentConfigs()
      return {
        jsonrpc: '2.0', id: req.id ?? null,
        result: {
          content: [{ type: 'text', text: JSON.stringify(configs, null, 2) }],
        },
      }
    }
    if (name === 'openclaw_session_key') {
      const taskId = args.taskId as string
      const key = this.orchestrator.getOpenClawSessionKey(taskId)
      if (!key) {
        return {
          jsonrpc: '2.0', id: req.id ?? null,
          result: { content: [{ type: 'text', text: `Task not found: ${taskId}` }], isError: true },
        }
      }
      return {
        jsonrpc: '2.0', id: req.id ?? null,
        result: { content: [{ type: 'text', text: JSON.stringify({ taskId, sessionKey: key }) }] },
      }
    }
    if (name === 'openclaw_resolve_key') {
      const sessionKey = args.sessionKey as string
      const task = this.orchestrator.resolveOpenClawKey(sessionKey)
      if (!task) {
        return {
          jsonrpc: '2.0', id: req.id ?? null,
          result: {
            content: [{ type: 'text', text: `No task found for key: ${sessionKey}` }],
            isError: true,
          },
        }
      }
      return {
        jsonrpc: '2.0', id: req.id ?? null,
        result: { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] },
      }
    }

    const result = await this.orchestrator.callTool(name, args)
    return {
      jsonrpc: '2.0', id: req.id ?? null,
      result: { content: [{ type: 'text', text: String(result) }] },
    }
  }

  private listResources(req: JsonRpcRequest): JsonRpcResponse {
    return {
      jsonrpc: '2.0',
      id: req.id ?? null,
      result: {
        resources: [
          {
            uri: 'helper://state', name: 'Orchestrator State',
            mimeType: 'application/json', description: 'Current agent/session state',
          },
          {
            uri: 'helper://sessions', name: 'Sessions',
            mimeType: 'application/json', description: 'All conversation sessions',
          },
          {
            uri: 'helper://agents', name: 'Agents',
            mimeType: 'application/json', description: 'Active agents',
          },
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
  getTasks(status?: string): unknown[]
  getTask(taskId: string): { task: unknown; events: unknown[] }
  createTask(input: Record<string, unknown>): unknown
  transitionTask(taskId: string, toStatus: string, reason: string): unknown
  spawnTask(request: SpawnTaskRequest): { taskId: string; accepted: boolean; reason?: string }
  getSpawnStatus(): { active: number; limit: number }
  submitReview(
    taskId: string,
    verdict: 'pass' | 'fail',
    reason: string,
    reviewerTaskId?: string,
    repairInstructions?: string,
  ): unknown
  getReviewHistory(taskId: string): unknown[]
  getRolePolicies(): Record<string, unknown>
  requestApproval(taskId: string, reason: string, requestedBy?: string): unknown
  approveTask(taskId: string, resolvedBy?: string): unknown
  rejectTask(taskId: string, resolvedBy?: string): unknown
  listPendingApprovals(): unknown[]
  runValidators(taskId: string): Promise<unknown[]>
  getMetrics(): unknown
  getTaskMetrics(taskId: string): unknown
  getAlerts(): unknown[]
  // OpenClaw interop
  exportOpenClawState(): unknown
  getOpenClawAgentConfigs(): unknown[]
  getOpenClawSessionKey(taskId: string): string | null
  resolveOpenClawKey(key: string): unknown | null
}

export interface SpawnTaskRequest {
  parentTaskId: string
  role: string
  label: string
  toolScope: string[]
  timeoutSeconds: number
  modelOverride?: string
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
