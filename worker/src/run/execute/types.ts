import type { ChannelSystemType, PrismaClient } from '@prisma/client'
import type { AgentEffort, AgentRunLimits } from '@nessie/schemas'
import type { SecretResolver, SecretStore } from '@nessie/mcp-manage'
import type { SearchExecutionConfig, SearchResult } from '@nessie/memory'
import type {
  DeepSignalMcpIdentityService,
  LedgerIdentityService,
  ModelClient,
  PgRealtimeTransport,
  QueueProvider,
  ReplyRootMetadata,
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
    /**
     * Optional explicit per-run caps (`Agent.runLimits`). Absent/`null` means
     * every dimension is governed by the deployment backstop — `effort` is
     * reasoning effort only, never a spend cap.
     */
    runLimits?: AgentRunLimits | null
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
    // Run row creation ≈ enqueue instant (run.create + job enqueue share one
    // transaction), used as the queue-wait baseline for run.timing.
    createdAt: Date
  }
  task: {
    id: string
  }
  /**
   * Reply-thread placement (#233): the root message this run's agent-authored
   * messages attach to — `triggerMessage.rootMessageId ?? triggerMessage.id`
   * (one level deep). Resolved in `executeRunJob` once the trigger message and
   * DeepWater handoff marker are known; `undefined` for runs without a trigger
   * message and for handoff runs, whose message flow stays byte-identical.
   */
  replyRootMessageId?: string
}

export type RunPlanContext = {
  planId: string
  rootStepId: string
}

// Reply-thread placement (#233): set when a run-authored message was created
// as a reply into a root message's reply thread, together with the root's
// post-bookkeeping metadata from `applyReplyBookkeeping`.
export type ReplyPlacement = {
  rootMessageId: string
  meta: ReplyRootMetadata
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
