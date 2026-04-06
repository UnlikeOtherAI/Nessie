import { allTools } from '../tools/index.js'
import { findToolByName } from '../tools/Tool.js'
import type { ToolUseContext, ToolUseBlock } from '../tools/types.js'
import type { OrchestratorState, SubAgentTask, AgentMessage, ManagedAgent } from './types.js'
import type { LlmClient } from '../llm/client.js'
import { llmStream } from '../llm/streaming.js'
import { insertMessage, getThreadHistory } from '../db/database.js'
import { evaluateAndCompress } from '../engine/compression.js'
import { TaskLedger } from '../orchestration/task-ledger.js'
import { TaskStatus } from '../orchestration/task-types.js'
import type { CreateTaskInput, Task, TaskEvent as OrchestratorTaskEvent } from '../orchestration/task-types.js'
import { SpawnManager } from '../orchestration/spawn-manager.js'
import type { AnnouncePayload, SpawnRequest, SpawnResult } from '../orchestration/spawn-manager.js'
import { VerificationGate } from '../orchestration/verification.js'
import type { ReviewResult } from '../orchestration/verification.js'
import { getRolePolicy, ROLE_POLICIES } from '../orchestration/role-registry.js'
import type { RolePolicy } from '../orchestration/role-registry.js'

export class Orchestrator {
  private state: OrchestratorState
  private callbacks: OrchestratorCallbacks
  private llm: LlmClient | null
  private schedules = new Map<string, TimerHandle>()
  private taskLedger: TaskLedger
  private spawnManager: SpawnManager
  private verificationGate: VerificationGate

  constructor(options: OrchestratorOptions) {
    this.state = {
      agents: [
        {
          id: 'main',
          name: 'Nessie',
          type: 'orchestrator',
          responsibility: 'Primary orchestrator for the desktop assistant.',
          trigger: 'main',
          tools: ['Bash', 'FileRead', 'FileWrite', 'Glob', 'Grep', 'WebSearch'],
        },
      ],
      messages: [],
      subAgents: [],
      isListening: false,
      isSpeaking: false,
      currentAgent: options.defaultAgent ?? 'main',
      tasks: [],
    }
    this.callbacks = options.callbacks ?? {}
    this.llm = options.llm ?? null
    this.taskLedger = new TaskLedger()
    this.verificationGate = new VerificationGate(this.taskLedger)
    this.spawnManager = new SpawnManager(
      this.taskLedger,
      (taskId, payload) => this.handleAnnounce(taskId, payload),
    )
    // Mark orphaned in-progress tasks as failed after restart
    this.spawnManager.hydrate()

    // Load persisted messages from SQLite
    this.loadFromDb()
  }

  private loadFromDb() {
    try {
      const history = getThreadHistory('main', 200)
      this.state.messages = history.map(h => ({
        id: h.id,
        role: h.role,
        threadId: h.threadId,
        content: h.content,
        timestamp: h.timestamp,
      }))
      console.log(`[DB] Loaded ${history.length} history entries for main thread`)
    } catch (err) {
      console.warn('[DB] Failed to load history:', err)
    }
  }

  setLlm(llm: LlmClient) {
    this.llm = llm
  }

  getState(): OrchestratorState {
    return {
      ...this.state,
      tasks: this.taskLedger.getAllTasks(50),
    }
  }

  // ─── Handle text message ────────────────────────────────────────────────────

  async handleUserMessage(content: string, targetAgentId = 'main', alreadyPushed = false): Promise<string> {
    const targetAgent = this.resolveTargetAgent(targetAgentId, content)
    const threadId = targetAgent.id

    if (!alreadyPushed) {
      this.pushMessage({ role: 'user', threadId, content })
    }

    if (targetAgent.id === 'main') {
      const agentManagementResponse = await this.handleAgentManagement(content)
      if (agentManagementResponse) {
        return this.appendAssistantReply(agentManagementResponse, 'main')
      }

      const action = this.decideAction(content)

      let response: string
      switch (action.type) {
        case 'inject':
          response = await this.handleKeyboardInject(action.text ?? content)
          break
        case 'subagent':
          response = await this.handleSubAgentTask(action.task ?? content, action.tools ?? [])
          break
        default:
          response = await this.handleVoiceResponse('main')
          break
      }

      return this.appendAssistantReply(response, 'main')
    }

    const directResponse = await this.handleTargetedAgentMessage(targetAgent, content)
    return this.appendAssistantReply(directResponse, targetAgent.id)
  }

  // ─── Public streaming entry point for SSE ──────────────────────────────────
  // Handles routing + streams the response. Use for /chat SSE endpoint.

  async *streamResponse(content: string, targetAgentId: string): AsyncGenerator<string, void, undefined> {
    if (targetAgentId !== 'main') {
      const reply = await this.handleUserMessage(content, targetAgentId)
      yield reply
      return
    }

    // Push user message — broadcast to all clients including this sender
    this.pushMessage({ role: 'user', threadId: 'main', content })

    const agentMgmt = await this.handleAgentManagement(content)
    if (agentMgmt) {
      this.appendAssistantReply(agentMgmt, 'main')
      yield agentMgmt
      return
    }

    const action = this.decideAction(content)
    switch (action.type) {
      case 'inject': {
        const reply = await this.handleKeyboardInject(action.text ?? content)
        this.appendAssistantReply(reply, 'main')
        yield reply
        return
      }
      case 'subagent': {
        const reply = await this.handleSubAgentTask(action.task ?? content, action.tools ?? [])
        this.appendAssistantReply(reply, 'main')
        yield reply
        return
      }
      default: {
        const conversation = this.state.messages
          .filter(m => m.threadId === 'main')
          .slice(-12)
          .map(m => ({ role: m.role === 'assistant' ? 'assistant' as const : 'user' as const, content: m.content }))
        const runId = crypto.randomUUID()
        this.callbacks.onBroadcast?.({ type: 'streaming.start', runId, threadId: 'main' })
        let full = ''
        try {
          for await (const delta of llmStream(conversation)) {
            full += delta
            this.callbacks.onBroadcast?.({ type: 'streaming.delta', content: delta })
            yield delta
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          this.callbacks.onBroadcast?.({ type: 'error', message: msg })
          yield `LLM error: ${msg}`
          return
        }
        this.callbacks.onBroadcast?.({ type: 'streaming.done', content: full, runId })
        this.pushMessage({ role: 'assistant', threadId: 'main', content: full })
        this.scheduleCompression('main')
      }
    }
  }

  // ─── Stream voice response (yields deltas for SSE) ────────────────────────────
  // Returns the full response content so the caller can persist it.
  // IMPORTANT: does NOT call pushMessage — the caller handles that to avoid
  // double-pushing when using the SSE streaming path.

  async *streamVoiceResponse(threadId: string): AsyncGenerator<string, void, undefined> {
    if (!this.llm) {
      const msg = 'No LLM client configured.'
      this.callbacks.onBroadcast?.({ type: 'error', message: msg })
      yield msg
      return
    }

    const conversation = this.state.messages
      .filter((message) => message.threadId === threadId)
      .slice(-12)
      .map((message) => ({
        role: message.role === 'assistant' ? 'assistant' as const : 'user' as const,
        content: message.content,
      }))

    const runId = crypto.randomUUID()
    this.callbacks.onBroadcast?.({ type: 'streaming.start', runId, threadId })

    let full = ''
    try {
      for await (const delta of llmStream(conversation)) {
        full += delta
        this.callbacks.onBroadcast?.({ type: 'streaming.delta', content: delta })
        yield delta
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.callbacks.onBroadcast?.({ type: 'error', message: msg })
      yield `LLM error: ${msg}`
      return
    }

    this.callbacks.onBroadcast?.({ type: 'streaming.done', content: full, runId })
  }

  // ─── Session / thread management ────────────────────────────────────────────

  async *handleUserMessageStreaming(
    content: string,
    targetAgentId = 'main',
  ): AsyncGenerator<string, string, undefined> {
    const targetAgent = this.resolveTargetAgent(targetAgentId, content)
    const threadId = targetAgent.id

    this.pushMessage({ role: 'user', threadId, content })

    if (targetAgent.id === 'main') {
      const agentManagementResponse = await this.handleAgentManagement(content)
      if (agentManagementResponse) {
        return this.appendAssistantReply(agentManagementResponse, 'main')
      }

      const action = this.decideAction(content)

      switch (action.type) {
        case 'inject': {
          const response = await this.handleKeyboardInject(action.text ?? content)
          return this.appendAssistantReply(response, 'main')
        }
        case 'subagent': {
          const response = await this.handleSubAgentTask(action.task ?? content, action.tools ?? [])
          return this.appendAssistantReply(response, 'main')
        }
        default: {
          // Stream voice response — push assistant message to state after streaming
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          for await (const _ of this.streamVoiceResponse('main')) {
            // deltas are broadcast via onBroadcast
          }
          // After streaming, push the assistant reply (extracted from streaming.done event content)
          // Note: for handleUserMessageStreaming, the SSE client pushes to state
          return ''
        }
      }
    }

    const directResponse = await this.handleTargetedAgentMessage(targetAgent, content)
    return this.appendAssistantReply(directResponse, targetAgent.id)
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  private resolveTargetAgent(targetAgentId: string, content: string): ManagedAgent {
    const selectedAgent = this.getAgent(targetAgentId) ?? this.getAgent('main')
    if (!selectedAgent) throw new Error('Main agent is not configured.')
    if (selectedAgent.id !== 'main') return selectedAgent
    return this.resolveExplicitTargetAgent(content) ?? selectedAgent
  }

  private decideAction(
    content: string,
  ): { type: 'voice' | 'inject' | 'subagent'; text?: string; task?: string; tools?: string[] } {
    const lower = content.toLowerCase()
    const isSearch = lower.includes('search') || lower.includes('find')
      || lower.includes('look up') || lower.includes('research')
    if (isSearch) {
      return { type: 'subagent', task: content, tools: ['WebSearch', 'Bash', 'FileRead', 'Glob', 'Grep'] }
    }
    if (lower.includes('type this') || lower.includes('write in') || lower.includes('fill in')) {
      return { type: 'inject', text: content.replace(/type this|write in|fill in/gi, '').trim() }
    }
    return { type: 'voice' }
  }

  private async handleAgentManagement(content: string): Promise<string | null> {
    const lower = content.toLowerCase()
    const wantsCreate = /\b(create|build|add|make|setup|set up)\b/.test(lower) && (
      lower.includes('agent') || lower.includes('coder') || lower.includes('weather')
    )

    if (wantsCreate) {
      const summaries: string[] = []
      if (lower.includes('coder')) {
        summaries.push(this.ensureAgent({
          id: 'coder', name: 'Coder', type: 'coder',
          responsibility: 'On-demand coding agent.',
          trigger: 'on-demand', tools: ['Bash', 'FileRead', 'FileWrite', 'Glob', 'Grep'],
        }))
      }
      if (lower.includes('weather')) {
        summaries.push(this.ensureAgent({
          id: 'weather-watcher', name: 'Weather Watcher', type: 'weather',
          responsibility: 'Hourly weather updates.',
          trigger: 'hourly', tools: ['WebSearch'], intervalMinutes: 60,
        }))
      }
      if (summaries.length > 0) return summaries.join(' ')
    }

    if (lower.includes('what agents') || lower.includes('list agents') || lower.includes('which agents')) {
      const agents = this.state.agents.map((a) => `${a.name} [${a.trigger}] - ${a.responsibility}`).join('\n')
      return agents ? `Agents:\n${agents}` : 'No agents configured.'
    }
    return null
  }

  private ensureAgent(agent: ManagedAgent): string {
    const existing = this.state.agents.find((a) => a.id === agent.id)
    if (existing) return `${existing.name} already exists.`
    const next: ManagedAgent = {
      ...agent,
      lastRunAt: undefined,
      nextRunAt: agent.intervalMinutes ? Date.now() + agent.intervalMinutes * 60_000 : undefined,
    }
    this.state.agents.push(next)
    this.broadcastState()
    if (next.type === 'weather' && next.intervalMinutes) {
      this.startWeatherSchedule(next.id, next.intervalMinutes)
      void this.postWeatherUpdate(next.id, 'initial')
    }
    return `${next.name} created.`
  }

  private resolveExplicitTargetAgent(content: string): ManagedAgent | null {
    const lower = content.toLowerCase()
    for (const agent of this.state.agents) {
      if (agent.trigger !== 'on-demand') continue
      const name = agent.name.toLowerCase()
      const matchesAgent = lower.startsWith(`@${name}`) || lower.startsWith(`${name}:`)
        || lower.startsWith(`${name} `) || lower.includes(`ask ${name}`)
      if (matchesAgent) {
        return agent
      }
    }
    return null
  }

  private async handleTargetedAgentMessage(agent: ManagedAgent, content: string): Promise<string> {
    if (!this.llm) return `${agent.name} is configured, but no LLM client is available.`
    const threadMessages = this.state.messages
      .filter((m) => m.threadId === agent.id)
      .slice(-12)
      .map((m) => ({
        role: m.role === 'assistant' ? 'assistant' as const : 'user' as const,
        content: m.content,
      }))
    const prompt = content
      .replace(new RegExp(`^@?${agent.name}\\s*:?\\s*`, 'i'), '')
      .replace(new RegExp(`^ask\\s+${agent.name}\\s+(to\\s+)?`, 'i'), '')
      .trim() || content
    const systemMsg = {
      role: 'system' as const,
      content: `You are ${agent.name}. Responsibility: ${agent.responsibility}`,
    }
    const reply = await this.llm.chat([systemMsg, ...threadMessages, { role: 'user', content: prompt }])
    return `${agent.name}: ${reply}`
  }

  private async handleKeyboardInject(text: string): Promise<string> {
    await this.callbacks.injectToActiveApp?.(text)
    return `Injected: ${text}`
  }

  private async handleVoiceResponse(threadId: string): Promise<string> {
    if (!this.llm) return 'No LLM client configured.'
    const conversation = this.state.messages
      .filter((m) => m.threadId === threadId)
      .slice(-12)
      .map((m) => ({
        role: m.role === 'assistant' ? 'assistant' as const : 'user' as const,
        content: m.content,
      }))
    return await this.llm.chat(conversation)
  }

  private async handleSubAgentTask(task: string, toolNames: string[]): Promise<string> {
    if (!this.llm) return 'No LLM configured for sub-agent responses.'

    const subAgent: SubAgentTask = {
      id: crypto.randomUUID(), name: `research-${Date.now()}`,
      task, tools: toolNames, status: 'running',
    }
    this.state.subAgents.push(subAgent)
    this.broadcastState()
    this.callbacks.onBroadcast?.({
      type: 'subagent.started',
      subAgent: { id: subAgent.id, name: subAgent.name, task: subAgent.task, status: 'running' },
    })

    const spawnResult = this.spawnManager.spawn({
      parentTaskId: null,
      role: 'researcher',
      label: task,
      toolScope: toolNames,
      timeoutSeconds: 300,
    })

    if (!spawnResult.accepted) {
      subAgent.status = 'failed'
      subAgent.error = spawnResult.reason
      this.broadcastState()
      return `Spawn rejected: ${spawnResult.reason}`
    }

    const taskId = spawnResult.taskId
    this.callbacks.onBroadcast?.({
      type: 'task.spawned',
      taskId,
      parentTaskId: null,
      role: 'researcher',
      label: task,
    })

    this.transitionTask(taskId, TaskStatus.Assigned, 'Sub-agent created')
    this.transitionTask(taskId, TaskStatus.InProgress, 'Sub-agent running')

    let rawResult: string
    let success = true
    try {
      rawResult = await this.spawnSubAgent(subAgent)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      rawResult = errMsg
      success = false
    }

    if (!success) {
      // Update sub-agent state BEFORE completing spawn so consumers see consistent state
      subAgent.status = 'failed'
      subAgent.error = rawResult
      this.broadcastState()
      this.callbacks.onBroadcast?.({
        type: 'subagent.done', subAgentId: subAgent.id, result: rawResult, error: rawResult,
      })
      this.spawnManager.complete(taskId, false, rawResult, 1)
      return `Sub-agent failed: ${rawResult}`
    }

    subAgent.status = 'done'
    subAgent.result = rawResult
    this.broadcastState()
    this.callbacks.onBroadcast?.({ type: 'subagent.done', subAgentId: subAgent.id, result: rawResult })
    this.spawnManager.complete(taskId, true, rawResult, 1)

    try {
      const response = await this.llm.chat([
        {
          role: 'system',
          content: 'You are a helpful assistant. A research task was just completed. '
            + 'Summarize the results in 1-3 clear sentences for the user. '
            + 'Be concise and practical. Do not mention tools, JSON, or raw data.',
        },
        { role: 'user', content: `Original question: ${task}\n\nResearch results:\n${rawResult}` },
      ], { maxTokens: 300 })
      return response
    } catch {
      return `Here's what I found: ${rawResult}`
    }
  }

  private handleAnnounce(taskId: string, payload: AnnouncePayload): void {
    try {
      const task = this.taskLedger.getTask(taskId)
      if (payload.status === 'completed') {
        if (task && task.status === 'in_progress') {
          this.transitionTask(taskId, TaskStatus.Review, 'Spawn completed')
        }
        const policy = task ? getRolePolicy(task.role) : null
        if (policy?.requiresReview) {
          // Task stays in review — a reviewer must explicitly pass it
        } else {
          this.transitionTask(taskId, TaskStatus.Done, payload.result)
        }
      } else {
        this.transitionTask(taskId, TaskStatus.Failed, payload.result)
      }
    } catch {
      // Task may already be in terminal state from explicit complete() call
    }

    this.callbacks.onBroadcast?.({
      type: 'task.announced',
      taskId: payload.taskId,
      parentTaskId: payload.parentTaskId,
      status: payload.status,
      result: payload.result,
      duration: payload.duration,
      toolCallCount: payload.toolCallCount,
    })

    if (payload.parentTaskId) {
      this.pushMessage({
        role: 'system',
        threadId: 'main',
        content: `Task ${taskId} ${payload.status}: ${payload.result}`,
      })
    }
  }

  spawnTask(request: SpawnRequest): SpawnResult {
    const result = this.spawnManager.spawn(request)
    if (result.accepted) {
      this.callbacks.onBroadcast?.({
        type: 'task.spawned',
        taskId: result.taskId,
        parentTaskId: request.parentTaskId ?? null,
        role: request.role,
        label: request.label,
      })
      this.transitionTask(result.taskId, TaskStatus.Assigned, 'Spawned')
      this.transitionTask(result.taskId, TaskStatus.InProgress, 'Running')
    }
    return result
  }

  getSpawnStatus(): { active: number; limit: number } {
    return this.spawnManager.getSpawnStatus()
  }

  private async spawnSubAgent(task: SubAgentTask): Promise<string> {
    const context = this.makeContext()
    const toolName = task.tools.includes('WebSearch') ? 'WebSearch' : 'Bash'
    const toolInput = toolName === 'WebSearch' ? { query: task.task } : { command: task.task }
    const toolUse: ToolUseBlock = { id: task.id, name: toolName, input: toolInput }
    const tool = findToolByName(allTools, toolUse.name)
    if (!tool) return `Tool not found: ${toolUse.name}`

    this.callbacks.onBroadcast?.({
      type: 'tool.called', name: toolName, input: toolUse.input as Record<string, unknown>,
    })

    const parsed = tool.inputSchema.safeParse(toolUse.input)
    if (!parsed.success) return `Invalid input: ${parsed.error.message}`

    const result = await tool.call(parsed.data, context)
    const data = JSON.stringify(result.data)
    this.callbacks.onBroadcast?.({ type: 'tool.done', name: toolName, output: result.data })
    return data
  }

  private startWeatherSchedule(agentId: string, intervalMinutes: number) {
    const existing = this.schedules.get(agentId)
    if (existing) clearInterval(existing)
    const handle = setInterval(() => { void this.postWeatherUpdate(agentId, 'scheduled') }, intervalMinutes * 60_000)
    this.schedules.set(agentId, handle)
  }

  private async postWeatherUpdate(agentId: string, reason: 'initial' | 'scheduled') {
    const agent = this.state.agents.find((a) => a.id === agentId)
    if (!agent) return
    try {
      const summary = await this.fetchWeatherSummary()
      const now = Date.now()
      agent.lastRunAt = now
      agent.nextRunAt = agent.intervalMinutes ? now + agent.intervalMinutes * 60_000 : undefined
      const label = reason === 'initial' ? ' initial report' : ' hourly update'
      this.pushMessage({
        role: 'assistant', threadId: 'main',
        content: `${agent.name}${label}: ${summary}`, timestamp: now,
      })
      this.callbacks.onBroadcast?.({ type: 'agent.wake', agentId, reason })
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      this.pushMessage({ role: 'system', threadId: 'main', content: `${agent.name} failed: ${errMsg}` })
    }
  }

  private async fetchWeatherSummary(): Promise<string> {
    const location = process.env.HELPER_WEATHER_QUERY?.trim() ?? ''
    const path = location ? `/${encodeURIComponent(location)}` : ''
    const response = await fetch(`https://wttr.in${path}?format=3`)
    if (!response.ok) throw new Error(`weather lookup failed with ${response.status}`)
    return (await response.text()).trim()
  }

  private appendAssistantReply(content: string, threadId: string): string {
    this.pushMessage({ role: 'assistant', threadId, content })
    // Fire-and-forget compression after assistant response
    this.scheduleCompression(threadId)
    return content
  }

  private scheduleCompression(threadId: string) {
    setTimeout(() => {
      if (!this.llm) return
      try {
        void evaluateAndCompress(this.state.messages.filter(m => m.threadId === threadId), threadId, this.llm)
      } catch { /* ignore compression errors */ }
    }, 0)
  }

  pushMessage(input: {
    role: 'user' | 'assistant' | 'system'; threadId: string; content: string; timestamp?: number
  }) {
    const msg: AgentMessage = {
      id: crypto.randomUUID(), role: input.role,
      threadId: input.threadId, content: input.content,
      timestamp: input.timestamp ?? Date.now(),
    }
    this.state.messages.push(msg)
    this.broadcastState()
    this.callbacks.onBroadcast?.({
      type: 'message',
      message: {
        id: msg.id, role: msg.role, threadId: msg.threadId,
        content: msg.content, timestamp: msg.timestamp,
      },
    })
    // Persist to SQLite
    try {
      insertMessage({
        id: msg.id, role: msg.role, threadId: msg.threadId,
        content: msg.content, timestamp: msg.timestamp,
      })
    } catch (err) {
      console.warn('[DB] Failed to persist message:', err)
    }
  }

  private broadcastState() {
    this.callbacks.onStateChange?.(this.state)
  }

  private getAgent(agentId: string): ManagedAgent | undefined {
    return this.state.agents.find((a) => a.id === agentId)
  }

  private makeContext(): ToolUseContext {
    return {
      abortController: new AbortController(),
      messages: this.state.messages,
      getAppState: () => ({
        isOnline: true, isListening: this.state.isListening,
        isSpeaking: this.state.isSpeaking, hotwordActive: false, activeAgentId: undefined,
      }),
      setAppState: () => {},
      options: { tools: allTools, debug: false },
    }
  }

  setListening(listening: boolean) { this.state.isListening = listening; this.broadcastState() }
  setSpeaking(speaking: boolean) { this.state.isSpeaking = speaking; this.broadcastState() }

  broadcastToolEvent(
    event: { type: 'tool.called'; name: string; input: Record<string, unknown> }
      | { type: 'tool.done'; name: string; output: unknown },
  ) {
    this.callbacks.onBroadcast?.(event as import('../events.js').ServerEvent)
  }

  // ─── Task ledger public API ─────────────────────────────────────────────────

  getTasks(status?: string): Task[] {
    if (status) return this.taskLedger.getTasksByStatus(status as TaskStatus)
    return this.taskLedger.getAllTasks()
  }

  getTask(taskId: string): { task: Task | null; events: OrchestratorTaskEvent[] } {
    const task = this.taskLedger.getTask(taskId)
    const events = task ? this.taskLedger.getTaskEvents(taskId) : []
    return { task, events }
  }

  createTask(input: CreateTaskInput): Task {
    const task = this.taskLedger.createTask(input)
    this.callbacks.onBroadcast?.({
      type: 'task.created',
      task: {
        id: task.id, parentId: task.parentId, role: task.role,
        label: task.label, status: task.status,
        createdAt: task.createdAt, updatedAt: task.updatedAt,
      },
    })
    return task
  }

  transitionTask(taskId: string, toStatus: string, reason: string): Task {
    const before = this.taskLedger.getTask(taskId)
    if (before && before.status === 'review' && toStatus === 'done') {
      if (!this.verificationGate.hasPassingReview(taskId)) {
        throw new Error(
          `Task ${taskId} requires a passing review before transitioning to done`,
        )
      }
    }
    const task = this.taskLedger.transition(taskId, toStatus as TaskStatus, reason)
    this.callbacks.onBroadcast?.({
      type: 'task.state_changed',
      taskId: task.id,
      fromStatus: before?.status ?? 'unknown',
      toStatus: task.status,
      reason,
    })
    return task
  }

  submitReview(
    taskId: string,
    verdict: 'pass' | 'fail',
    reason: string,
    repairInstructions?: string,
  ): ReviewResult {
    const review = this.verificationGate.submitReview(
      taskId, verdict, reason, repairInstructions,
    )
    if (verdict === 'pass') {
      this.callbacks.onBroadcast?.({
        type: 'task.review_passed',
        taskId,
        reason,
      })
      this.transitionTask(taskId, TaskStatus.Done, `Review passed: ${reason}`)
    } else {
      this.callbacks.onBroadcast?.({
        type: 'task.review_failed',
        taskId,
        reason,
        repairInstructions: repairInstructions ?? null,
      })
      this.transitionTask(
        taskId, TaskStatus.InProgress,
        `Review failed: ${reason}`,
      )
    }
    return review
  }

  getReviewHistory(taskId: string): ReviewResult[] {
    return this.verificationGate.getReviewHistory(taskId)
  }

  getRolePolicies(): Record<string, RolePolicy> {
    return { ...ROLE_POLICIES }
  }

  close() {
    for (const handle of this.schedules.values()) clearInterval(handle)
    this.schedules.clear()
    this.spawnManager.close()
  }
}

export type OrchestratorOptions = {
  defaultAgent?: string
  callbacks?: OrchestratorCallbacks
  llm?: LlmClient
}

export type OrchestratorCallbacks = {
  onStateChange?: (state: OrchestratorState) => void
  injectToActiveApp?: (text: string) => Promise<void>
  /** Called with every server→client event. Use to broadcast to WS clients and SSE streams. */
  onBroadcast?: (event: import('../events.js').ServerEvent) => void
}

type TimerHandle = ReturnType<typeof setInterval>
