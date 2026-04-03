import { allTools } from '../tools/index.js'
import { findToolByName } from '../tools/Tool.js'
import type { ToolUseContext, ToolUseBlock } from '../tools/types.js'
import type { OrchestratorState, SubAgentTask, AgentMessage } from './types.js'

export class Orchestrator {
  private state: OrchestratorState
  private callbacks: OrchestratorCallbacks

  constructor(options: OrchestratorOptions) {
    this.state = {
      messages: [],
      subAgents: [],
      isListening: false,
      isSpeaking: false,
      currentAgent: options.defaultAgent ?? 'main',
    }
    this.callbacks = options.callbacks ?? {}
  }

  getState(): OrchestratorState {
    return this.state
  }

  async handleUserMessage(content: string): Promise<string> {
    const message: AgentMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      timestamp: Date.now(),
    }
    this.state.messages.push(message)

    // Decide what to do based on message content
    const action = this.decideAction(content)

    switch (action.type) {
      case 'inject':
        return await this.handleKeyboardInject(action.text ?? content)
      case 'subagent':
        return await this.handleSubAgentTask(action.task ?? content, action.tools ?? [])
      default:
        // Voice response - return the content for voice synthesis
        return content
    }
  }

  private decideAction(content: string): { type: 'voice' | 'inject' | 'subagent'; text?: string; task?: string; tools?: string[] } {
    const lower = content.toLowerCase()
    if (lower.includes('search') || lower.includes('find') || lower.includes('look up') || lower.includes('research')) {
      return { type: 'subagent', task: content, tools: ['WebSearch', 'Bash', 'FileRead', 'Glob', 'Grep'] }
    }
    if (lower.includes('type this') || lower.includes('write in') || lower.includes('fill in')) {
      return { type: 'inject', text: content.replace(/type this|write in|fill in/gi, '').trim() }
    }
    return { type: 'voice' }
  }

  private async handleKeyboardInject(text: string): Promise<string> {
    await this.callbacks.injectToActiveApp?.(text)
    return `Injected: ${text}`
  }

  private async handleSubAgentTask(task: string, toolNames: string[]): Promise<string> {
    const subAgent: SubAgentTask = {
      id: crypto.randomUUID(),
      name: `research-${Date.now()}`,
      task,
      tools: toolNames,
      status: 'running',
    }
    this.state.subAgents.push(subAgent)

    // Spawn sub-agent via `max` CLI (MiniMax-powered Claude)
    // In MVP: run synchronously with tool calls
    const result = await this.spawnSubAgent(subAgent)
    subAgent.status = 'done'
    subAgent.result = result

    return `Research complete: ${result}`
  }

  private async spawnSubAgent(task: SubAgentTask): Promise<string> {
    const toolUseContext = this.makeContext()

    // Use the most relevant tool for the task
    const toolName = task.tools.includes('WebSearch') ? 'WebSearch' : 'Bash'
    const toolUse: ToolUseBlock = {
      id: task.id,
      name: toolName,
      input: toolName === 'WebSearch' ? { query: task.task } : { command: task.task },
    }

    const tool = findToolByName(allTools, toolUse.name)
    if (!tool) return `Tool not found: ${toolUse.name}`

    const parsed = tool.inputSchema.safeParse(toolUse.input)
    if (!parsed.success) return `Invalid input: ${parsed.error.message}`

    const result = await tool.call(parsed.data, toolUseContext)
    return JSON.stringify(result.data)
  }

  private makeContext(): ToolUseContext {
    return {
      abortController: new AbortController(),
      messages: this.state.messages,
      getAppState: () => ({
        isOnline: true,
        isListening: this.state.isListening,
        isSpeaking: this.state.isSpeaking,
        hotwordActive: false,
        activeAgentId: undefined,
      }),
      setAppState: () => {},
      options: {
        tools: allTools,
        debug: false,
      },
    }
  }

  setListening(listening: boolean) {
    this.state.isListening = listening
    this.callbacks.onStateChange?.(this.state)
  }

  setSpeaking(speaking: boolean) {
    this.state.isSpeaking = speaking
    this.callbacks.onStateChange?.(this.state)
  }
}

export type OrchestratorOptions = {
  defaultAgent?: string
  callbacks?: OrchestratorCallbacks
}

export type OrchestratorCallbacks = {
  onStateChange?: (state: OrchestratorState) => void
  injectToActiveApp?: (text: string) => Promise<void>
}
