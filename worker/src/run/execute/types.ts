import type { PrismaClient } from '@prisma/client'
import type { SearchExecutionConfig, SearchResult } from '@nessie/memory'
import type { ModelClient, PgRealtimeTransport, QueueProvider } from '@nessie/runtime'

export type ExecutionDependencies = {
  modelClient: ModelClient
  prisma: PrismaClient
  queueProvider: QueueProvider
  realtimeTransport: PgRealtimeTransport
  searchConfig: SearchExecutionConfig
}

export type RunContext = {
  agent: {
    agentKind: 'personal_assistant' | 'shared'
    id: string
    name: string
    model: string | null
    parentAgentId: string | null
    provider: string | null
    systemPrompt: string | null
  }
  channel: {
    id: string
    organizationId: string
    systemChannelType: 'personal_assistant' | null
  }
  run: {
    id: string
    threadId: string
  }
  task: {
    id: string
  }
}

export type RunPlanContext = {
  planId: string
  rootStepId: string
}

export type StoredConversationMessage = {
  content: string
  role: 'assistant' | 'system' | 'user'
}

export type RetrievedMemory = Pick<SearchResult, 'content' | 'recallId'>

export type BudgetModelOverride = {
  model: string | null
  provider: string | null
}
