import { AgentIdSchema, ChannelIdSchema, ThreadIdSchema } from '@nessie/schemas'
import { z } from 'zod'

import { MessageAuthorSchema } from './messaging.js'
import { TimestampSchema } from './shared.js'

export const ListThreadActivityQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  unread: z.enum(['true', '1']).optional(),
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
  /**
   * The container thread's own title and agent, so the inbox can name a
   * conversation ("Q3 pricing review") instead of only its room, and link
   * straight to `/channels/:channelId/threads/:threadId`. Both are null on a
   * General row, which is every row that existed before conversations.
   */
  threadTitle: z.string().nullable(),
  threadAgentId: AgentIdSchema.nullable(),
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
  hasMore: z.boolean(),
  nextCursor: z.string().min(1).optional(),
})

export type ThreadActivityRecord = z.infer<typeof ThreadActivityRecordSchema>
