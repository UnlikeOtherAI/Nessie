import {
  AgentIdSchema,
  ChannelIdSchema,
  DemonstrationDetailRecordSchema,
  DemonstrationRecordSchema,
  ThreadIdSchema,
} from '@nessie/schemas'
import { z } from 'zod'

const DemonstrationIdSchema = z.string().uuid()

export const DemonstrationParamsSchema = z.object({
  demonstrationId: DemonstrationIdSchema,
}).strict()

export const CreateDemonstrationBodySchema = z.object({
  agentId: AgentIdSchema,
  channelId: ChannelIdSchema,
  threadId: ThreadIdSchema,
}).strict()

export {
  DemonstrationDetailRecordSchema,
  DemonstrationRecordSchema,
}
