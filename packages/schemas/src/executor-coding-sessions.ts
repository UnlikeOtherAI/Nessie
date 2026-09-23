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
  })
  .strict()
export type ExecutorMcpCallOwner = z.infer<typeof ExecutorMcpCallOwnerSchema>

/**
 * The owner key the bridge isolates sessions by: `sha256:` and the hex SHA-256
 * of this text. The daemon derives it for `_meta['nessie/owner']`; the control
 * plane derives the same key to name an owner in `codingSessionClose`. The
 * executor id is part of it, so one person's key on one machine means nothing
 * on another. Hashing is each runtime's own; the text is this one function.
 */
export const executorCodingSessionOwnerKeyInput = (
  executorId: string,
  owner: { agentId: string; actorUserId: string },
): string => `${executorId}|${owner.agentId}|${owner.actorUserId}`

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
