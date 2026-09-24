import { z } from 'zod'

import { AgentIdSchema, UserIdSchema } from './ids.js'
import { TimestampSchema } from './schema-primitives.js'

/**
 * The executor's built-in `coding-sessions` bridge: a local MCP server that
 * runs Claude Code or Codex on the host as long-lived sessions an agent
 * instructs. Unlike every other named server it is not a program somebody
 * named — the executor generates its launch spec itself — and it acts with the
 * host OS user's full authority, so what it may do travels in the signed
 * descriptor, who is calling travels with every call, and what it is doing
 * travels on the heartbeat. The contract is
 * `docs/executor-protocol/host-coding-sessions.md`.
 */

/** Reserved: the executor refuses a hand-named server of this name. */
export const EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME = 'coding-sessions'

export const EXECUTOR_CODING_AGENT_NAMES = ['claude', 'codex'] as const
export const ExecutorCodingAgentNameSchema = z.enum(EXECUTOR_CODING_AGENT_NAMES)
export type ExecutorCodingAgentName = z.infer<typeof ExecutorCodingAgentNameSchema>

const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)

/** A root's name: the workspace-folder grammar, which the executor enforces in full. */
const CodingRootNameSchema = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(40)

/** A categorical reason, never free text: `lease_ended`, `host_lost`, `agent_missing`, … */
const CodingReasonSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)

const distinct = (values: readonly string[]): boolean => new Set(values).size === values.length

const sameMembers = (left: readonly string[], right: readonly string[]): boolean => (
  [...left].sort().join(',') === [...right].sort().join(',')
)

/* -------------------------------------------------------------------------- */
/* The reviewed power facts                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What the bridge may do, stated in the signed descriptor and so inside
 * `localPolicyDigest`: which coding agents, in which standing permission mode,
 * with how many pre-allowed tools, in which named folders. `configDigest`
 * covers the whole host-local configuration those facts summarise, and the
 * bridge refuses to start an agent while the file on disk hashes to anything
 * else — editing it changes nothing until a person reviews the new revision.
 *
 * Present exactly when the executor offers the bridge. Folder paths, agent
 * programs and their arguments stay on the host, as a named server's launch
 * spec always has.
 */
export const ExecutorCodingSessionsFactsSchema = z
  .object({
    serverName: z.literal(EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME),
    agents: z.array(ExecutorCodingAgentNameSchema).min(1).max(EXECUTOR_CODING_AGENT_NAMES.length)
      .refine(distinct, 'Each coding agent is named once.'),
    /**
     * Per offered agent: Claude Code's `--permission-mode` (`default` when the
     * configuration sets none), or for Codex the approval and sandbox stance
     * its reviewed arguments choose.
     */
    permissionMode: z.record(ExecutorCodingAgentNameSchema, z.string().regex(/^[A-Za-z][A-Za-z0-9:_-]{0,63}$/)),
    /** Claude Code's `allowedTools` entries — commands it may run without being asked. */
    allowedToolCount: z.number().int().min(0).max(128),
    /**
     * The environment variables the configuration sets or passes to the agents
     * (`agentEnv.set` and `agentEnv.pass`), by name and sorted: a
     * `CLAUDE_CONFIG_DIR` or an `ANTHROPIC_BASE_URL` changes what an agent may
     * do, or where its transcript goes, as surely as a flag does. Values stay on
     * the host.
     */
    environmentNames: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)).max(128)
      .refine(distinct, 'Each environment variable is named once.'),
    rootNames: z.array(CodingRootNameSchema).min(1).max(16).refine(distinct, 'Each coding root is named once.'),
    configDigest: Sha256DigestSchema,
  })
  .strict()
  .refine(
    (facts) => sameMembers(Object.keys(facts.permissionMode), facts.agents),
    'Every offered coding agent states its permission mode, and only those do.',
  )
export type ExecutorCodingSessionsFacts = z.infer<typeof ExecutorCodingSessionsFactsSchema>

/* -------------------------------------------------------------------------- */
/* Owners                                                                      */
/* -------------------------------------------------------------------------- */

const LowercaseUuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

/**
 * The work an owner's sessions belong to, beside the agent and the person:
 * `ticket:<policyId>:<taskId>` for one ticket's work under a standing policy.
 * Absent for a launch and a conversation lease, whose sessions are the
 * person's own with that agent. It is hashed into the owner key, so a ticket's
 * sessions are isolated from the person's own and from every other ticket's,
 * and each has its own live-session quota. Lowercase ids only: the key hashes
 * the text, and one id spelled two ways would be two owners.
 */
export const ExecutorCodingSessionOwnerContextSchema = z
  .string()
  .regex(new RegExp(`^ticket:${LowercaseUuidPattern}:${LowercaseUuidPattern}$`))

/**
 * Who an `mcp.call` acts for, stamped by the worker from the binding's
 * candidate — never taken from the model. It rides the command payload beside
 * `runId`, outside the model's `arguments`, so the argument digest covers it
 * and no tool call can name somebody else.
 */
export const ExecutorMcpCallOwnerSchema = z
  .object({
    agentId: AgentIdSchema,
    actorUserId: UserIdSchema,
    contextId: ExecutorCodingSessionOwnerContextSchema.optional(),
  })
  .strict()
export type ExecutorMcpCallOwner = z.infer<typeof ExecutorMcpCallOwnerSchema>

/**
 * The owner key the bridge isolates sessions by: `sha256:` and the hex SHA-256
 * of this text. The daemon derives it for `_meta['nessie/owner']`; the control
 * plane derives the same key to name an owner in `codingSessionClose`. The
 * executor id is part of it, so one person's key on one machine means nothing
 * on another. A context is a fourth field; without one the text is the three
 * ids exactly as before it existed, so no session's key changed. None of the
 * ids can hold a vertical bar, so no three-field text equals a four-field one.
 * Hashing is each runtime's own; the text is this one function.
 */
export const executorCodingSessionOwnerKeyInput = (
  executorId: string,
  owner: { agentId: string; actorUserId: string; contextId?: string },
): string => [
  executorId, owner.agentId, owner.actorUserId, ...(owner.contextId === undefined ? [] : [owner.contextId]),
].join('|')

export const ExecutorCodingSessionOwnerKeySchema = Sha256DigestSchema

/* -------------------------------------------------------------------------- */
/* Teardown and the admin's view                                               */
/* -------------------------------------------------------------------------- */

/**
 * One instruction on a heartbeat response: close this owner's coding sessions
 * (or one of them) on this machine. The control plane sends it when a lease
 * ends, access is revoked, the executor is paused, or a person presses Close.
 */
export const ExecutorCodingSessionCloseSchema = z
  .object({
    ownerKey: ExecutorCodingSessionOwnerKeySchema,
    sessionId: z.string().uuid().optional(),
    reason: CodingReasonSchema,
  })
  .strict()
export type ExecutorCodingSessionClose = z.infer<typeof ExecutorCodingSessionCloseSchema>

/**
 * Why the control plane asks for a close — the vocabulary of the stored close
 * requests, which a CHECK pins. The wire field stays the open categorical
 * grammar above, so a daemon never refuses a reason it has not met yet.
 *
 * - `lease_ended`: the owner's last live conversation lease on the machine
 *   ended — its holder or a machine administrator pressed End, it expired,
 *   the executor drained, or a review dropped the local-apps pair;
 * - `access_revoked`: the agent's access to the machine, or the owner's place
 *   on its roster, was withdrawn;
 * - `executor_paused`, `executor_revoked`: the machine itself was fenced;
 * - `person`: a person pressed Close on one session.
 *
 * One ticket's work under a standing policy closes its own sessions, each
 * named by id (docs/plans/2026-09-23-ticket-driven-agents/machine-access.md
 * → "Server-side closes"):
 *
 * - `ticket_left_flow`: the ticket entered one of the trigger's end columns;
 * - `trigger_changed`: the trigger was disabled, deleted, or edited in a
 *   pinned field;
 * - `policy_suspended`: the policy was suspended, its trigger or descriptor
 *   digest having changed;
 * - `policy_ended`: the policy ended — End, a fence, its author gone;
 * - `work_limit`: the work record hit one of its limits.
 */
export const EXECUTOR_CODING_SESSION_CLOSE_REASONS = [
  'lease_ended',
  'access_revoked',
  'executor_paused',
  'executor_revoked',
  'person',
  'ticket_left_flow',
  'trigger_changed',
  'policy_suspended',
  'policy_ended',
  'work_limit',
] as const
export const ExecutorCodingSessionCloseReasonSchema = z.enum(EXECUTOR_CODING_SESSION_CLOSE_REASONS)
export type ExecutorCodingSessionCloseReason = z.infer<typeof ExecutorCodingSessionCloseReasonSchema>

export const EXECUTOR_CODING_SESSION_CLOSE_MAXIMUM = 64

export const ExecutorCodingSessionCloseListSchema = z
  .array(ExecutorCodingSessionCloseSchema)
  .max(EXECUTOR_CODING_SESSION_CLOSE_MAXIMUM)

export const ExecutorCodingSessionStatusSchema = z.enum([
  'starting',
  'working',
  'waiting_for_input',
  'interrupted',
  'failed',
  'closed',
])
export type ExecutorCodingSessionStatus = z.infer<typeof ExecutorCodingSessionStatusSchema>

/**
 * One open session as the local-MCP report states it: enough for a person to
 * recognise it and close it, and nothing of what it said or did — no prompt,
 * no transcript, no path. The title is the task's first line as the bridge
 * recorded it, rewritten so no host path survives.
 */
export const ExecutorCodingSessionSummarySchema = z
  .object({
    sessionId: z.string().uuid(),
    ownerKey: ExecutorCodingSessionOwnerKeySchema,
    title: z.string().min(1).max(120),
    status: ExecutorCodingSessionStatusSchema,
    reason: CodingReasonSchema.optional(),
    agent: ExecutorCodingAgentNameSchema,
    root: CodingRootNameSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
export type ExecutorCodingSessionSummary = z.infer<typeof ExecutorCodingSessionSummarySchema>

export const EXECUTOR_CODING_SESSION_REPORT_MAXIMUM = 32

/**
 * One open session as the executor page lists it, for the people who manage
 * the machine: what the local-MCP report said, plus two answers only the
 * control plane has. The agent driving it is named only when the reader could
 * see that agent themselves — the Agents tab's own rule — so `null` is a
 * boundary, not a gap. `closing` says a close request for it is open: the
 * machine has been told, and its next report has not yet dropped the session.
 */
export const ExecutorCodingSessionRecordSchema = ExecutorCodingSessionSummarySchema
  .extend({
    closing: z.boolean(),
    ownerAgentName: z.string().min(1).nullable(),
  })
  .strict()
export type ExecutorCodingSessionRecord = z.infer<typeof ExecutorCodingSessionRecordSchema>

export const ExecutorCodingSessionListResponseSchema = z
  .object({
    /**
     * Whether this reader may press Close: the person who paired the machine,
     * whom every session on it acts as, and nobody else who manages it.
     */
    canClose: z.boolean(),
    sessions: z.array(ExecutorCodingSessionRecordSchema).max(EXECUTOR_CODING_SESSION_REPORT_MAXIMUM),
  })
  .strict()
export type ExecutorCodingSessionListResponse = z.infer<typeof ExecutorCodingSessionListResponseSchema>

/** A person's Close on one session, named exactly as the list named it. */
export const ExecutorCodingSessionCloseBodySchema = z
  .object({
    ownerKey: ExecutorCodingSessionOwnerKeySchema,
    sessionId: z.string().uuid(),
  })
  .strict()
export type ExecutorCodingSessionCloseBody = z.infer<typeof ExecutorCodingSessionCloseBodySchema>

/**
 * Accepted, not done: the request rides the machine's next heartbeat as
 * `codingSessionClose`, and the list reads "Closing…" until a report no
 * longer carries the session.
 */
export const ExecutorCodingSessionCloseAcceptedSchema = z
  .object({
    closing: z.literal(true),
    sessionId: z.string().uuid(),
  })
  .strict()
export type ExecutorCodingSessionCloseAccepted = z.infer<typeof ExecutorCodingSessionCloseAcceptedSchema>
