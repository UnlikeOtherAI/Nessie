import type { ChannelSystemType, PrismaClient } from '@prisma/client'
import type { SecretResolver, SecretStore } from '@nessie/mcp-manage'
import type { CaptureConfig } from '@nessie/memory'
import type { ConnectorUsage, ModelClient, PgRealtimeTransport } from '@nessie/runtime'
import type { RunExecuteJobPayload } from '@nessie/schemas'

export type ToolExecutionUsage = Omit<ConnectorUsage, 'latencyMs' | 'success'>

export type ToolExecutionResult = {
  connectorUsage?: ToolExecutionUsage
  inputSummary: string
  outputPreview: string
  toolName: string
}

export type BuiltinToolRuntimeContext = {
  agentId: string
  agentKind: 'personal_assistant' | 'shared'
  actorContext: RunExecuteJobPayload['actorContext']
  channel: {
    id: string
    organizationId: RunExecuteJobPayload['actorContext']['tenant']['organizationId']
    systemChannelType?: ChannelSystemType | null
  }
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
    messageId: string
    originatingUserId?: string | null
    threadId: string
  }
}
