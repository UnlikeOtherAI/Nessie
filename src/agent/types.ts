export type AgentMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  threadId: string
  content: string
  timestamp: number
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
}
