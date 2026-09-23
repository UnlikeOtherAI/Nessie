import { createHash, randomUUID } from 'node:crypto'

import {
  EXECUTOR_CODING_SESSION_REPORT_MAXIMUM,
  ExecutorCodingSessionCloseListSchema,
  executorCodingSessionOwnerKeyInput,
  ExecutorCodingSessionSummarySchema,
  type ExecutorCodingSessionClose,
  type ExecutorCodingSessionsFacts,
  type ExecutorCodingSessionSummary,
  type ExecutorMcpCallOwner,
} from '@nessie/schemas'

import { loadCodingSessionsConfig } from './coding-session/config.js'
import {
  CODING_SESSION_COMMAND_META,
  CODING_SESSION_DAEMON_CONTROL_META,
  CODING_SESSION_OWNER_META,
} from './coding-session/meta-keys.js'
import { codingSessionsPolicyOf, codingSessionsServerConfigPath } from './coding-sessions-policy.js'
import type { ExecutorLocalMcpServer } from './mcp-servers.js'
import type { ExecutorMcpSessionManager } from './mcp-session-manager.js'

/**
 * The daemon's half of coding-sessions.md §3 and §5: who each bridge call is
 * for, and how sessions end when the daemon's authority does.
 *
 * Owners. The worker stamps an `mcp.call` payload with `owner: {agentId,
 * actorUserId}`. For calls to the executor's own coding-sessions bridge — and
 * no other server, ever — the daemon turns it into `_meta['nessie/owner'] =
 * sha256(executorId|agentId|actorUserId)` and adds `_meta['nessie/command']`,
 * the command id that makes a replay a no-op. The model's `arguments` are
 * passed on untouched.
 *
 * Teardown. The daemon keeps the owner keys it has dispatched for, and calls
 * the bridge's daemon-only `session_close_all` wherever it already stops its
 * other sessions — a failed command poll or heartbeat — and at shutdown when
 * the reviewed configuration opts in. Sessions from an earlier daemon life may
 * exist too, so the first teardown after start closes everything; once one has
 * succeeded, a teardown with no owner dispatched since is skipped rather than
 * starting a bridge process to close nothing. The heartbeat response's
 * `codingSessionClose` closes named owners' sessions (or one of them) the
 * same way. The daemon-only `session_list_all` feeds the local-MCP report.
 */

export const codingSessionOwnerKey = (executorId: string, owner: ExecutorMcpCallOwner): string => (
  `sha256:${createHash('sha256').update(executorCodingSessionOwnerKeyInput(executorId, owner)).digest('hex')}`
)

export type CodingSessionsDaemon = {
  /** The reserved `_meta` for one call: defined only for the built-in bridge. */
  callMeta: (
    server: string, input: { commandId: string; owner?: ExecutorMcpCallOwner },
  ) => Record<string, unknown> | undefined
  /** Every session on this machine, as the daemon's authority ends. */
  closeAll: (reason: string) => Promise<void>
  /** The control plane's instructions from a heartbeat response; anything malformed is ignored. */
  close: (instructions: unknown) => Promise<void>
  /** At shutdown, when the reviewed configuration opts in. */
  shutdown: () => Promise<void>
  /** The open sessions for the local-MCP report, or undefined when the bridge could not say. */
  report: () => Promise<ExecutorCodingSessionSummary[] | undefined>
}

type TextResult = { content?: { text?: unknown }[]; success?: unknown }

const answerOf = (result: Record<string, unknown>): Record<string, unknown> | undefined => {
  const text = (result as TextResult).content?.[0]?.text
  if (result.success !== true || typeof text !== 'string') return undefined
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

export const createCodingSessionsDaemon = (input: {
  executorId: string
  facts: ExecutorCodingSessionsFacts | undefined
  servers: readonly ExecutorLocalMcpServer[]
  sessions: ExecutorMcpSessionManager
  log?: (message: string) => void
}): CodingSessionsDaemon => {
  const bridge = codingSessionsPolicyOf(input.facts, input.servers)?.server
  const log = input.log ?? ((message: string) => { console.error(`[nessie-executor] ${message}`) })
  const owners = new Set<string>()
  let earlierSessionsMayExist = bridge !== undefined
  let queue: Promise<unknown> = Promise.resolve()

  // Serialised, so a poll failure and a heartbeat failure in the same second
  // do not both find the registry non-empty and close everything twice.
  const serially = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work)
    queue = run.catch(() => undefined)
    return run
  }

  const daemonCall = async (
    tool: string, args: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined> => {
    if (!bridge) return undefined
    const result = await input.sessions.callTool(bridge.name, tool, args, {
      [CODING_SESSION_DAEMON_CONTROL_META]: true,
      [CODING_SESSION_COMMAND_META]: `daemon-${randomUUID()}`,
    })
    const answer = answerOf(result)
    if (!answer) log(`the coding-sessions bridge did not complete ${tool}`)
    return answer
  }

  return {
    callMeta: (server, call) => {
      if (!bridge || server !== bridge.name) return undefined
      const ownerKey = call.owner ? codingSessionOwnerKey(input.executorId, call.owner) : undefined
      if (ownerKey) owners.add(ownerKey)
      return {
        [CODING_SESSION_COMMAND_META]: call.commandId,
        ...(ownerKey ? { [CODING_SESSION_OWNER_META]: ownerKey } : {}),
      }
    },
    closeAll: (reason) => serially(async () => {
      if (!bridge || (!earlierSessionsMayExist && owners.size === 0)) return
      const dispatched = [...owners]
      if (await daemonCall('session_close_all', { reason })) {
        earlierSessionsMayExist = false
        for (const owner of dispatched) owners.delete(owner)
      }
    }),
    close: (instructions) => serially(async () => {
      const parsed = ExecutorCodingSessionCloseListSchema.safeParse(instructions)
      if (!bridge || !parsed.success) return
      for (const entry of parsed.data as ExecutorCodingSessionClose[]) {
        const closed = await daemonCall('session_close_all', {
          ownerKey: entry.ownerKey, reason: entry.reason, ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
        })
        if (closed && !entry.sessionId) owners.delete(entry.ownerKey)
      }
    }),
    shutdown: async () => {
      if (!bridge) return
      const configPath = codingSessionsServerConfigPath(bridge)
      const loaded = configPath ? await loadCodingSessionsConfig(configPath).catch(() => undefined) : undefined
      // A configuration that no longer matches its review cannot be trusted to
      // have opted out, so it is read as having opted in.
      const optedIn = loaded?.digest !== input.facts?.configDigest || loaded?.config.closeOnDaemonShutdown === true
      if (optedIn) await serially(async () => { await daemonCall('session_close_all', { reason: 'daemon_shutdown' }) })
    },
    report: async () => {
      const answer = await serially(() => daemonCall('session_list_all', {}))
      if (!answer || !Array.isArray(answer.sessions)) return undefined
      return answer.sessions.flatMap((entry) => {
        const parsed = ExecutorCodingSessionSummarySchema.safeParse(entry)
        return parsed.success ? [parsed.data] : []
      }).slice(0, EXECUTOR_CODING_SESSION_REPORT_MAXIMUM)
    },
  }
}
