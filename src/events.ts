/**
 * src/events.ts — Shared event types for the WS broadcast bus and SSE stream.
 * All server → client events flow through here.
 */

export type ServerEvent =
  | ServerEventState
  | ServerEventMessage
  | ServerEventStreamingStart
  | ServerEventStreamingDelta
  | ServerEventStreamingDone
  | ServerEventSubAgentStarted
  | ServerEventSubAgentDone
  | ServerEventToolCalled
  | ServerEventToolDone
  | ServerEventAgentWake
  | ServerEventError
  | ServerEventTaskCreated
  | ServerEventTaskStateChanged

// ─── State ────────────────────────────────────────────────────────────────────

export interface ServerEventState {
  type: 'state'
  data: {
    agents: AgentSummary[]
    messages: MessageSummary[]
    subAgents: SubAgentSummary[]
    isListening: boolean
    isSpeaking: boolean
  }
}

export interface AgentSummary {
  id: string
  name: string
  type: string
  trigger: string
}

export interface MessageSummary {
  id: string
  role: string
  threadId: string
  content: string
  timestamp: number
}

export interface SubAgentSummary {
  id: string
  name: string
  task: string
  status: 'pending' | 'running' | 'done' | 'failed'
}

// ─── Messages ─────────────────────────────────────────────────────────────────

export interface ServerEventMessage {
  type: 'message'
  message: {
    id: string
    role: 'user' | 'assistant' | 'system'
    threadId: string
    content: string
    timestamp: number
  }
}

// ─── Streaming ────────────────────────────────────────────────────────────────

export interface ServerEventStreamingStart {
  type: 'streaming.start'
  runId: string
  threadId: string
}

export interface ServerEventStreamingDelta {
  type: 'streaming.delta'
  content: string
}

export interface ServerEventStreamingDone {
  type: 'streaming.done'
  content: string
  runId: string
}

// ─── Sub-agents ───────────────────────────────────────────────────────────────

export interface ServerEventSubAgentStarted {
  type: 'subagent.started'
  subAgent: SubAgentSummary
}

export interface ServerEventSubAgentDone {
  type: 'subagent.done'
  subAgentId: string
  result: string
  error?: string
}

// ─── Tools ────────────────────────────────────────────────────────────────────

export interface ServerEventToolCalled {
  type: 'tool.called'
  name: string
  input: Record<string, unknown>
}

export interface ServerEventToolDone {
  type: 'tool.done'
  name: string
  output: unknown
}

// ─── Agent scheduling ─────────────────────────────────────────────────────────

export interface ServerEventAgentWake {
  type: 'agent.wake'
  agentId: string
  reason: 'initial' | 'scheduled'
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

export interface TaskSummary {
  id: string
  parentId: string | null
  role: string
  label: string
  status: string
  createdAt: number
  updatedAt: number
}

export interface ServerEventTaskCreated {
  type: 'task.created'
  task: TaskSummary
}

export interface ServerEventTaskStateChanged {
  type: 'task.state_changed'
  taskId: string
  fromStatus: string
  toStatus: string
  reason: string
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export interface ServerEventError {
  type: 'error'
  message: string
}
