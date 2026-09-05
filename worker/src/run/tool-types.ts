import type { ChannelSystemType, PrismaClient } from '@prisma/client'
import type { CloudBrowserDeps } from '@nessie/browser-cloud'
import type { SecretResolver, SecretStore } from '@nessie/mcp-manage'
import type { CaptureConfig } from '@nessie/memory'
import type { ConsumedSourceSink } from './execute/disclosure-basis.js'
import type { DocumentStreamRecorder } from './execute/document-stream.js'
import type { RunContext } from './execute/types.js'
import type {
  ConnectorUsage,
  LedgerIdentityService,
  ModelClient,
  PgRealtimeTransport,
} from '@nessie/runtime'
import type { RunExecuteJobPayload } from '@nessie/schemas'

export type ToolExecutionUsage = Omit<ConnectorUsage, 'latencyMs' | 'success'>

/**
 * A tool that posted an interactive card and asked to wait for the answer.
 * Unlike an approval gate — decided *before* dispatch — this is decided after,
 * because the card has to exist before anybody can press it.
 */
export type AgentCardSuspension = {
  cardId: string
}

export type ToolExecutionResult = {
  connectorUsage?: ToolExecutionUsage
  inputSummary: string
  outputPreview: string
  pendingInput?: AgentCardSuspension
  toolName: string
}

// What the agentic loop receives back from a tool call: a settled result, never
// a throw. Lives here rather than in `tools.ts` so the per-domain dispatchers
// can type themselves without importing the main dispatcher.
export type AgenticToolResult = {
  acknowledgeDelivery?: () => void
  connectorUsage?: ToolExecutionUsage
  inputSummary: string
  output: string
  pendingInput?: AgentCardSuspension
  success: boolean
  /** A pre-created durable ToolCall used by an executor command. */
  toolCallRecordId?: string
}

export type BuiltinToolRuntimeContext = {
  agentId: string
  agentKind: 'personal_assistant' | 'shared'
  actorContext: RunExecuteJobPayload['actorContext']
  /**
   * Private execution capability added only by the authorizer after its
   * one-time Gmail approval proof was consumed. A raw payload token is never
   * authority for the send handler.
   */
  gmailDraftSendApproved?: true
  /** Standing consent already resolved by the authorization chokepoint. */
  gmailDraftSendStandingAuthorized?: true
  /**
   * Keeps the run-local opt-in capture state in sync when the model starts or
   * stops a demonstration during this very run. Ordinary tool fixtures need
   * not provide it.
   */
  demonstrationControl?: {
    clearActive: () => void
    setActive: (demonstrationId: string) => void
  }
  channel: {
    id: string
    organizationId: RunExecuteJobPayload['actorContext']['tenant']['organizationId']
    /** One level of the setting cascade; absent on a channel with no team. */
    teamId?: string | null
    systemChannelType?: ChannelSystemType | null
  }
  /**
   * Scoped sources the run has consumed so far. Tools that persist content —
   * `send_message`, knowledge-base writes — consult it so a run holding
   * restricted material cannot write that material somewhere unrestricted.
   * Optional so partial test fixtures keep compiling; absent is treated as
   * "nothing consumed", which is the pre-existing behaviour.
   */
  consumedSources?: ConsumedSourceSink
  /**
   * The run's live document stream. `kb_document_compose` awaits its own
   * session here before saving, so the file it writes is exactly the document
   * the person watched arrive. Absent in test fixtures and on runs that never
   * streamed one, which simply means no live preview existed.
   */
  documentStream?: DocumentStreamRecorder
  /**
   * Browserbase transport plumbing for the `browser_*` builtins: the prisma
   * handle plus the resolver that turns a stored `secret_browserbase_*` ref
   * back into an API key. Optional so partial test fixtures keep compiling;
   * absent means the deployment has no cloud browsing and the tools say so.
   */
  cloudBrowser?: CloudBrowserDeps
  /**
   * Visibility and stewardship, which decide whether this agent's durable
   * browser may live on its owner's personal Browserbase account or must use
   * the organisation's.
   */
  agentIdentity?: { visibility: 'team' | 'private'; ownerUserId: string | null }
  /** Deployment secret used only to decrypt an acknowledged executor receipt
   * while preparing a user-owned continuation. It is never model-visible. */
  executorCommandEncryptionSecret?: string
  ledgerIdentity: LedgerIdentityService | null
  // MCP credential plumbing for the connector management tools: the store
  // encrypts user-provided secrets into Postgres, the resolver resolves any
  // credentialRef for probes. Optional so existing test fixtures that build a
  // partial context keep compiling; connector tools fail with a clear message
  // when absent.
  mcpSecrets?: {
    store: SecretStore
    resolver: SecretResolver
    oauthCallbackUrl?: string
  }
  memoryCaptureConfig?: CaptureConfig | null
  // Shared inference client for tools that need it directly (e.g. kb_search's
  // query embedding step). Optional so existing test fixtures that build a
  // partial context by hand keep compiling; absence just degrades kb_search
  // to lexical-only search.
  modelClient?: ModelClient
  prisma: PrismaClient
  realtimeTransport: PgRealtimeTransport
  run: {
    id: string
    /** True only for a live human conversational turn, never automation. */
    interactive?: boolean
    messageId: string
    originatingUserId?: string | null
    principalUserId?: string | null
    threadId: string
  }
  /** The complete run context used by the one disclosure-stamped message write. */
  runContext?: RunContext
  toolCallId: string | null
}
