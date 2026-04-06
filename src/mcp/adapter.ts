/**
 * Adapter that exposes the Orchestrator as an McpOrchestrator.
 */

import type {
  McpOrchestrator,
  ListMessagesOptions,
  ListMessagesResult,
  MessageForMcp,
} from './server.js'
import type { Orchestrator } from '../agent/Orchestrator.js'
import { allTools, findToolByName } from '../tools/index.js'
import type { ToolUseContext } from '../tools/types.js'

export function createMcpAdapter(orchestrator: Orchestrator): McpOrchestrator {
  return {
    getState() {
      const state = orchestrator.getState()
      return {
        agents: state.agents.map(a => ({ id: a.id, name: a.name, type: a.type, trigger: a.trigger })),
        messages: state.messages.map(m => ({
          id: m.id,
          role: m.role,
          content: m.content,
          threadId: m.threadId,
          timestamp: m.timestamp,
        })),
        sessions: [], // derived from messages in server.ts
        isListening: state.isListening,
        isSpeaking: state.isSpeaking,
      }
    },

    listMessages(opts: ListMessagesOptions): ListMessagesResult {
      const all = orchestrator.getState().messages

      // Filter by threadId
      const threadId = opts.threadId ?? 'main'
      const filtered = all.filter(m => m.threadId === threadId)

      // Sort oldest-first for "older" direction
      const sorted = [...filtered].sort((a, b) => a.timestamp - b.timestamp)
      const total = sorted.length

      const limit = opts.limit ?? 50
      const offset = opts.offset ?? 0

      let page: typeof sorted
      if (opts.direction === 'newer') {
        // From offset, take limit newest messages (reversed order)
        page = sorted.slice(Math.max(0, total - offset - limit), total - offset).reverse()
      } else {
        // Default: oldest messages, paginating forward
        page = sorted.slice(offset, offset + limit)
      }

      const messages: MessageForMcp[] = page.map(m => ({
        id: m.id,
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.content,
        threadId: m.threadId,
        timestamp: m.timestamp,
      }))

      return {
        messages,
        total,
        hasMore: offset + messages.length < total,
      }
    },

    async callTool(name: string, args: Record<string, unknown>): Promise<string> {
      // invoke_tool wraps args as { name: 'Bash', input: {...} }
      const toolName = (args.name as string | undefined) ?? name
      const input = (args.input as Record<string, unknown> | undefined) ?? args

      const tool = findToolByName(allTools, toolName)
      if (!tool) return `Tool not found: ${toolName}`

      const parsed = tool.inputSchema.safeParse(input)
      if (!parsed.success) return `Invalid input: ${parsed.error.message}`

      // Broadcast tool.called event so the app UI updates
      orchestrator.broadcastToolEvent({ type: 'tool.called', name: toolName, input })

      const context: ToolUseContext = {
        abortController: new AbortController(),
        messages: orchestrator.getState().messages,
        getAppState: () => ({
          isOnline: true,
          isListening: orchestrator.getState().isListening,
          isSpeaking: orchestrator.getState().isSpeaking,
          hotwordActive: false,
        }),
        setAppState: () => {},
        options: { tools: allTools, debug: false },
      }

      try {
        const result = await tool.call(parsed.data, context)
        orchestrator.broadcastToolEvent({ type: 'tool.done', name: toolName, output: result.data })
        return JSON.stringify(result.data, null, 2)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        orchestrator.broadcastToolEvent({ type: 'tool.done', name: toolName, output: { error: msg } })
        return `Error: ${msg}`
      }
    },

    pushMessage(input: { role: 'user' | 'assistant' | 'system'; threadId: string; content: string }) {
      orchestrator.pushMessage(input)
    },

    async sendMessage(message: string, threadId: string): Promise<string> {
      const reply = await orchestrator.handleUserMessage(message, threadId)
      return reply
    },

    streamResponse(message: string, threadId: string): AsyncGenerator<string, void, undefined> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return orchestrator.streamResponse(message, threadId) as any
    },

    getTasks(status?: string) {
      return orchestrator.getTasks(status)
    },

    getTask(taskId: string) {
      return orchestrator.getTask(taskId)
    },

    createTask(input: Record<string, unknown>) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return orchestrator.createTask(input as any)
    },

    transitionTask(taskId: string, toStatus: string, reason: string) {
      return orchestrator.transitionTask(taskId, toStatus, reason)
    },
  }
}
