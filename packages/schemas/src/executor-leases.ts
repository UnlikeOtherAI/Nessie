import { z } from 'zod'

import { TimestampSchema } from './schema-primitives.js'

/**
 * The two readings of an executor conversation lease
 * (docs/plans/2026-09-22-executor-local-apps/conversation-lease.md §4).
 *
 * The holder's own view names the machine, because it is theirs; nobody else
 * is ever answered with a lease in a conversation — a private executor's name
 * must never reach a channel. The machine's view is for the people who manage
 * that executor, and names who holds each lease and where, but only names a
 * conversation its reader could open.
 */

export const ExecutorLeaseListQuerySchema = z.object({
  threadId: z.string().uuid(),
}).strict()
export type ExecutorLeaseListQuery = z.infer<typeof ExecutorLeaseListQuerySchema>

/** One of the viewer's own live leases in a conversation. */
export const ExecutorConversationLeaseRecordSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  executorLabel: z.string().min(1),
  threadId: z.string().uuid(),
  /** The launch message: replies under it carry. */
  rootMessageId: z.string().uuid(),
  /**
   * True inside a conversation with the lease's agent, where anything the
   * holder sends in the thread carries it — the main composer included.
   * False elsewhere: only a reply under `rootMessageId` does, and a top-level
   * post in the room never. A composer shows the lease only where sending
   * would carry it.
   */
  wholeThread: z.boolean(),
  launchedAt: TimestampSchema,
  /** The earlier of the idle and the absolute window; it moves with use. */
  expiresAt: TimestampSchema,
}).strict()
export type ExecutorConversationLeaseRecord = z.infer<typeof ExecutorConversationLeaseRecordSchema>

/**
 * A live lease on one executor, as its administrators see it. Managing the
 * machine is not a licence to read everything that uses it: the agent is
 * named only when the reader may see that agent, and the conversation only
 * when the reader could open it.
 */
export const ExecutorMachineLeaseRecordSchema = z.object({
  id: z.string().uuid(),
  agent: z.object({ id: z.string().uuid(), name: z.string().nullable() }).strict(),
  holderUserId: z.string().uuid(),
  /**
   * Null when the reader could not open that conversation themselves — then
   * not even its ids are given, since a private room's or a DM's id is
   * already more than the participant rule lets them know.
   */
  conversation: z.object({
    channelId: z.string().uuid(),
    threadId: z.string().uuid(),
    label: z.string(),
  }).strict().nullable(),
  launchedAt: TimestampSchema,
  lastUsedAt: TimestampSchema,
  expiresAt: TimestampSchema,
}).strict()
export type ExecutorMachineLeaseRecord = z.infer<typeof ExecutorMachineLeaseRecordSchema>

export const ExecutorLeaseEndResponseSchema = z.object({
  /** False when the lease had already ended; ending it is idempotent. */
  ended: z.boolean(),
  leaseId: z.string().uuid(),
}).strict()
export type ExecutorLeaseEndResponse = z.infer<typeof ExecutorLeaseEndResponseSchema>
