import type { ChannelSystemType, PrismaClient } from '@prisma/client'
import type { SecretResolver, SecretStore } from '@nessie/mcp-manage'
import type { SearchExecutionConfig, SearchResult } from '@nessie/memory'
import type {
  DeepSignalMcpIdentityService,
  LedgerIdentityService,
  ModelClient,
  PgRealtimeTransport,
  QueueProvider,
} from '@nessie/runtime'

export type ExecutionDependencies = {
  deepSignalMcpIdentity?: DeepSignalMcpIdentityService | null
  ledgerIdentity?: LedgerIdentityService | null
  /**
   * MCP credential plumbing: `store` encrypts assistant-collected secrets into
   * Postgres, `resolver` turns any credentialRef (pg-stored or env-var) into
   * plaintext for probes and dispatch. Optional so test fixtures that never
   * touch connectors keep working; connector features degrade to env-only
   * resolution without it.
   */
  mcpSecrets?: {
    store: SecretStore
    resolver: SecretResolver
    /** Absolute OAuth callback URL for assistant-minted authorization flows. */
    oauthCallbackUrl?: string
  }
  modelClient: ModelClient
  prisma: PrismaClient
  queueProvider: QueueProvider
  realtimeTransport: PgRealtimeTransport
  searchConfig: SearchExecutionConfig
}

export type RunContext = {
  agent: {
    agentKind: 'personal_assistant' | 'shared'
    executionMode: 'inference' | 'external_mcp'
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
    systemChannelType: ChannelSystemType | null
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
