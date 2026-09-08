import { z } from 'zod'

import {
  AgentIdSchema,
  ChannelIdSchema,
  RunIdSchema,
  ThreadIdSchema,
  UserIdSchema,
} from './ids.js'
import { RunStatusSchema, SystemChannelTypeSchema } from './lifecycle.js'
import { NonEmptyStringSchema, TimestampSchema } from './schema-primitives.js'

/**
 * A conversation with an agent, on the wire.
 *
 * A conversation **is** a `Thread` (docs/plans/2026-09-08-agent-conversations.md):
 * `threads.agent_id` names the agent it is with, and the room it lives in is
 * its audience — the people who can read that channel, no new ACL. A thread
 * with `agent_id NULL` is the room's own General thread and is not "with"
 * anyone; it still appears in an agent's list when the agent is bound to that
 * room, which is what makes the rooms an agent works in look like the
 * conversations they are.
 *
 * Every field here is stated by the server from rows it read. Nothing is
 * composed from message content and nothing is inferred by a model.
 */

/** How long a list/card preview of the newest readable message may be. */
export const CONVERSATION_PREVIEW_MAX_CHARS = 120
/** How long the "doing now" line lifted from the thought log may be. */
export const CONVERSATION_PROGRESS_LINE_MAX_CHARS = 160
/** The longest a conversation title may be, derived or typed. */
export const CONVERSATION_TITLE_MAX_CHARS = 80

/**
 * The statuses an *active* run can hold. A run in any of them still owns the
 * conversation's `(agent, thread)` slot, which is exactly what "active" means
 * here — the terminal three are reported through `lastRunOutcome` instead.
 */
export const ActiveRunStatusSchema = RunStatusSchema.extract([
  'pending',
  'running',
  'waiting_approval',
  'waiting_input',
])
export type ActiveRunStatus = z.infer<typeof ActiveRunStatusSchema>

/** How the last run in a conversation ended, so a card can stop saying "Running". */
export const RunOutcomeSchema = RunStatusSchema.extract([
  'completed',
  'failed',
  'cancelled',
])
export type RunOutcome = z.infer<typeof RunOutcomeSchema>

export const AgentConversationChannelSchema = z.object({
  id: ChannelIdSchema,
  label: NonEmptyStringSchema,
  type: z.enum(['standard', 'dm']),
  systemChannelType: SystemChannelTypeSchema.nullable(),
  /** Null for a standalone channel or a DM — there is no project to name. */
  projectName: z.string().nullable(),
})
export type AgentConversationChannel = z.infer<typeof AgentConversationChannelSchema>

export const AgentConversationActiveRunSchema = z.object({
  id: RunIdSchema,
  status: ActiveRunStatusSchema,
  startedAt: TimestampSchema.nullable(),
  /**
   * The newest readable thought-log line of the running run — what the card
   * and the list show as "doing now". Null when the run has written nothing
   * yet, is not yet running, or when the viewer would be withheld its reply
   * (`canUserReadRunBasis` false), exactly as `loadThreadThinking` withholds
   * the bubble's entries.
   */
  progressLine: z.string().nullable(),
})
export type AgentConversationActiveRun = z.infer<typeof AgentConversationActiveRunSchema>

export const AgentConversationRecordSchema = z.object({
  id: ThreadIdSchema,
  agentId: AgentIdSchema,
  /** Never empty: a General row carries the room's own name. */
  title: NonEmptyStringSchema,
  /** The room's own thread (`agent_id NULL`), listed through the binding arm. */
  isGeneral: z.boolean(),
  channel: AgentConversationChannelSchema,
  startedByUserId: UserIdSchema.nullable(),
  lastActivityAt: TimestampSchema.nullable(),
  /**
   * At most `CONVERSATION_PREVIEW_MAX_CHARS` of the newest message the viewer
   * may read. Fails closed: a message carrying any basis scope contributes
   * null, never a redaction.
   */
  lastMessagePreview: z.string().nullable(),
  unreadCount: z.number().int().nonnegative(),
  activeRun: AgentConversationActiveRunSchema.nullable(),
  /**
   * The last terminal run's outcome, so a card can say "Done" or "Failed"
   * after the live dot goes. Null until a run has finished in this thread.
   */
  lastRunOutcome: RunOutcomeSchema.nullable(),
  createdAt: TimestampSchema,
})
export type AgentConversationRecord = z.infer<typeof AgentConversationRecordSchema>

/**
 * `POST /api/agents/:agentId/conversations`.
 *
 * Every field is optional and every one is `undefined`-or-present, never
 * `null`: `.strict().optional()` rejects an explicit `null`, so a client that
 * means "no title" omits the key. `channelId` omitted asks the server to
 * resolve the room (the caller's DM with the agent, else the most recently
 * active room they may post in that binds it).
 */
export const StartAgentConversationBodySchema = z.object({
  channelId: ChannelIdSchema.optional(),
  title: z.string().trim().min(1).max(CONVERSATION_TITLE_MAX_CHARS).optional(),
  message: z.string().trim().min(1).optional(),
  clientMessageId: z.string().min(1).max(200).optional(),
}).strict()
export type StartAgentConversationBody = z.infer<typeof StartAgentConversationBodySchema>

/** `PATCH /api/threads/:threadId` — renaming a conversation. */
export const RenameThreadBodySchema = z.object({
  title: z.string().trim().min(1).max(CONVERSATION_TITLE_MAX_CHARS),
}).strict()
export type RenameThreadBody = z.infer<typeof RenameThreadBodySchema>
