export type AgentMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  threadId: string
  content: string
  timestamp: number
}

export interface PathPermissions {
  /** Glob patterns for allowed paths. If set, only matching paths are permitted. */
  allow?: string[]
  /** Glob patterns for denied paths. Takes precedence over allow. */
  block?: string[]
}

export type ManagedAgent = {
  id: string
  name: string
  type: 'orchestrator' | 'coder' | 'weather'
  responsibility: string
  trigger: 'main' | 'on-demand' | 'hourly'
  tools: string[]
  intervalMinutes?: number
  lastRunAt?: number
  nextRunAt?: number
  /** Optional per-agent path permissions for file access tools. */
  pathPermissions?: PathPermissions
}

export type SubAgentTask = {
  id: string
  name: string
  task: string
  tools: string[]  // tool names to assign
  status: 'pending' | 'running' | 'done' | 'failed'
  result?: string
  error?: string
}

export type OrchestratorState = {
  agents: ManagedAgent[]
  messages: AgentMessage[]
  subAgents: SubAgentTask[]
  isListening: boolean
  isSpeaking: boolean
  currentAgent: string
  tasks: import('../orchestration/task-types.js').Task[]
}
