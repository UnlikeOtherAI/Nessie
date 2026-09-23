/**
 * The shapes the coding-sessions bridge and its session hosts share on disk.
 *
 * Two writers never touch one file: the bridge writes `meta.json` once, at
 * `session_start`, and the requests in `inbox/`; the host alone writes
 * `session.json` and `events.jsonl`. Everything a reader derives — "host lost",
 * "starting" — is derived at read time rather than written back by the bridge.
 */

/**
 * Bumped whenever the bridge and host stop understanding each other's files.
 * A bridge that meets a host speaking an older version asks it to retire after
 * its current turn instead of driving it.
 */
export const CODING_SESSION_PROTOCOL_VERSION = 1

export const CODING_AGENT_NAMES = ['claude', 'codex'] as const
export type CodingAgentName = typeof CODING_AGENT_NAMES[number]

export type CodingSessionStatus =
  | 'starting'
  | 'working'
  | 'waiting_for_input'
  | 'interrupted'
  | 'failed'
  | 'closed'

/** A session counts against its owner's quota until it is closed or failed. */
export const codingSessionIsLive = (status: CodingSessionStatus): boolean => (
  status !== 'closed' && status !== 'failed'
)

/** Written once by the bridge; the owner and the reach of a session never change. */
export type CodingSessionMeta = {
  version: 1
  sessionId: string
  ownerKey: string
  agent: CodingAgentName
  rootName: string
  /** Root-relative and normalised; `.` is the root itself. */
  path: string
  title: string
  createdAt: string
}

export type CodingPermissionDenial = { tool: string; summary: string }

export type CodingSessionResult = {
  text: string
  isError: boolean
  subtype: string
  turns?: number
  /** This turn's cost: the CLI reports a per-process running total, so this is its delta. */
  costUsd?: number
  durationMs?: number
  permissionDenials: CodingPermissionDenial[]
  /** Set when the turn started without a message from us (a finished background task). */
  origin?: string
}

/**
 * A process the host started, identified well enough that a reused pid is
 * never signalled. `startedAt` is a decimal start time in the OS's own unit;
 * an identity without one is unknown, and nothing ever signals it.
 */
export type CodingProcessIdentity = { pid: number; startedAt?: string }

/** Host-written, debounced; never carries raw agent output. */
export type CodingSessionState = {
  version: 1
  status: CodingSessionStatus
  /** Categorical: `host_lost`, `agent_missing`, `agent_exited`, … never free text. */
  reason?: string
  updatedAt: string
  turn: number
  agentSessionId?: string
  /** True once the agent has written a transcript, so a new process resumes it. */
  agentSessionStarted?: boolean
  /**
   * The first message, kept until the agent confirms its session or answers a
   * turn: an agent lost before then (its host killed, or it exited, before its
   * init) took the message with it, so the next message carries it again.
   */
  firstPrompt?: string
  agentVersion?: string
  agentIdentity?: CodingProcessIdentity
  baseCommit?: string
  branch?: string
  /** Canonical host paths of the worktrees that existed at start; never reported raw. */
  worktreesAtStart?: string[]
  turnStartedAt?: string
  lastResult?: CodingSessionResult
  permissionDenials: CodingPermissionDenial[]
  totalCostUsd?: number
  lastTest?: { command: string; exitCode: number | null }
  eventsGeneration: number
  lastSeq: number
  /** Follow-ups waiting for the next turn (Codex runs one process per turn). */
  queued: number
  /** Background tasks the agent left running; they hold no turn open, and one finishing starts a turn of its own. */
  backgroundTasks?: number
}

/**
 * What a session reports, per kind, after projection. Nothing else reaches
 * `events.jsonl`: the raw agent stream is parsed in memory and dropped.
 */
export type CodingEventBody =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; name: string; summary: string }
  | { kind: 'tool_result'; name?: string; summary: string; isError?: true; exitCode?: number }
  | ({ kind: 'result' } & CodingSessionResult)
  | {
    kind: 'system'
    subtype: string
    model?: string
    permissionMode?: string
    message?: string
    reason?: string
    status?: CodingSessionStatus
    tool?: string
  }

export type CodingSessionEvent = CodingEventBody & { seq: number; at: string }

/** A request the bridge leaves for the host, named after the executor command that caused it. */
export type CodingSessionRequest = {
  id: string
  kind: 'start' | 'send' | 'interrupt' | 'close' | 'retire'
  text?: string
  reason?: string
  at: string
}

/** The agent CLIs' own session and thread ids, which later become argv: a UUID, never anything read as a flag. */
export const AGENT_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

export const CODING_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

export const initialCodingSessionState = (now: string): CodingSessionState => ({
  version: 1,
  status: 'starting',
  updatedAt: now,
  turn: 0,
  permissionDenials: [],
  eventsGeneration: 0,
  lastSeq: 0,
  queued: 0,
})
