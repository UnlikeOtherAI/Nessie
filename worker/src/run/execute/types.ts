import type { ChannelSystemType, PrismaClient } from '@prisma/client'
import type { AgentEffort } from '@nessie/schemas'
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
    effort: AgentEffort
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
  /**
   * The agent that authored this message, when it was produced by an agent
   * (assistant-role turns). `null` for human (`user`) messages. Used by the
   * prompt builder to distinguish the acting agent's own turns from those of
   * other agents sharing the thread, so a model never attributes another
   * agent's reply to itself (buzz #2287).
   */
  authorAgentId?: string | null
  /** Live display name of `authorAgentId`, resolved per run (rename-safe). */
  authorAgentName?: string | null
}

export type RetrievedMemory = Pick<SearchResult, 'content' | 'recallId'>

export type BudgetModelOverride = {
  model: string | null
  provider: string | null
}
