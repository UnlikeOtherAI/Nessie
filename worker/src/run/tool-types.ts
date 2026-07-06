import type { PrismaClient } from '@prisma/client'
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
    systemChannelType?: 'personal_assistant' | null
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
    threadId: string
  }
}
