import type { ChannelSystemType, PrismaClient, RunReplyPlacement } from '@prisma/client'
import type { AgentEffort, AgentRunLimits } from '@nessie/schemas'
import type { SecretResolver, SecretStore } from '@nessie/mcp-manage'
import type { SearchExecutionConfig, SearchResult } from '@nessie/memory'
import type {
  DeepSignalMcpIdentityService,
  LedgerIdentityService,
  ModelClient,
  PgRealtimeTransport,
  ProviderImage,
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
    /**
     * The pre-run placement judgement recorded on the run row (model-made by
     * the engagement orchestrator, or structural for @mentions and PA DMs).
     * `null` ≡ the historical default. Consumed only by
     * `resolveReplyRootMessageId`.
     */
    replyPlacement: RunReplyPlacement | null
  }
  task: {
    id: string
  }
  /**
   * Reply-thread placement (#233): the root message this run's agent-authored
   * messages attach to — `triggerMessage.rootMessageId ?? triggerMessage.id`
   * (one level deep). Resolved in `executeRunJob` once the trigger message,
   * DeepWater handoff marker, and placement judgement are known; `undefined`
   * for runs without a trigger message, for handoff runs (whose message flow
   * stays byte-identical), and when placement judged the reply to be a
   * standalone channel post.
   */
  replyRootMessageId?: string
  /**
   * The reply thread this run *reads*, which is not always the one it writes
   * into: set only when the trigger message is itself a reply, so a run
   * starting a new reply thread under a top-level message still sees the
   * channel conversation. See `resolveConversationRootMessageId`.
   */
  conversationRootMessageId?: string
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
   * One rendered line naming the files attached to this message, appended to
   * its text when the prompt is built. Kept beside `content` rather than inside
   * it so it never alters what the human actually wrote — the prompt builder's
   * "is the trigger message already the last turn?" check compares raw content.
   */
  attachmentNote?: string | null
  /**
   * Attached images, inlined so a vision-capable model can look at them. Only
   * ever set on `user` turns; connectors whose model is text-only drop them and
   * fall back to `attachmentNote`. See `../message-attachments.ts`.
   */
  images?: ProviderImage[]
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
