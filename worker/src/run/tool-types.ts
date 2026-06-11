import type { PrismaClient } from '@prisma/client'
import type { CaptureConfig } from '@nessie/memory'
import type { PgRealtimeTransport } from '@nessie/runtime'
import type { RunExecuteJobPayload } from '@nessie/schemas'

export type ToolExecutionResult = {
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
  prisma: PrismaClient
  realtimeTransport: PgRealtimeTransport
  run: {
    id: string
    messageId: string
    threadId: string
  }
}
