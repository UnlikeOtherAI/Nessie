import { AgentIdSchema, ChannelIdSchema, ThreadIdSchema } from '@nessie/schemas'
import { z } from 'zod'

import { MessageAuthorSchema } from './messaging.js'
import { TimestampSchema } from './shared.js'

export const ListThreadActivityQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

const ActivityMessageSchema = z.object({
  id: z.string().uuid(),
  content: z.string(),
  createdAt: TimestampSchema,
  author: MessageAuthorSchema.nullish(),
  agentId: AgentIdSchema.nullish(),
})

export const ThreadActivityRecordSchema = z.object({
  rootMessageId: z.string().uuid(),
  threadId: ThreadIdSchema,
  channelId: ChannelIdSchema,
  channelLabel: z.string(),
  root: ActivityMessageSchema,
  latestReply: ActivityMessageSchema,
  replyCount: z.number().int().nonnegative(),
  unread: z.boolean(),
})

export const ThreadActivityResponseSchema = z.object({
  items: z.array(ThreadActivityRecordSchema),
  unreadTotal: z.number().int().nonnegative(),
})

export type ThreadActivityRecord = z.infer<typeof ThreadActivityRecordSchema>
