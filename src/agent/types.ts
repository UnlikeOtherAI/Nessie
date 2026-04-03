export type AgentMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
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
  messages: AgentMessage[]
  subAgents: SubAgentTask[]
  isListening: boolean
  isSpeaking: boolean
  currentAgent: string
}
