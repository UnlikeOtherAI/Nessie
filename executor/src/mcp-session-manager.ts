import { createHash } from 'node:crypto'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import {
  canonicalExecutorJson,
  EXECUTOR_MCP_CALL_TIMEOUT_MS,
  EXECUTOR_MCP_START_TIMEOUT_MS,
  EXECUTOR_MCP_TOOL_MAXIMUM,
  type ExecutorMcpTool,
  type ExecutorMcpToolCatalog,
  type ExecutorMcpUnavailableReason,
} from '@nessie/schemas'

import {
  ExecutorMcpServerError,
  findExecutorLocalMcpServer,
  type ExecutorLocalMcpServer,
} from './mcp-servers.js'

// The start and call timeouts are shared with the worker, which builds each
// mcp command's expiry from them (`@nessie/schemas` executor-timing.ts): a
// start that may take ten seconds and a call that may take a minute both have
// to fit inside the command before it expires into an unknown outcome.
const MCP_SESSION_START_TIMEOUT_MS = EXECUTOR_MCP_START_TIMEOUT_MS
const MCP_CALL_TIMEOUT_MS = EXECUTOR_MCP_CALL_TIMEOUT_MS
// Sessions outlive single commands so a run's burst of tool calls reuses one
// process, but a bridge that keeps a server alive forever after one call
// leaks it; a minute of quiet retires the process.
const MCP_SESSION_IDLE_TIMEOUT_MS = 60_000
// A server that dies on every start must not be retried in a tight loop:
// after three consecutive start failures it sits out a minute.
const MCP_START_FAILURE_THRESHOLD = 3
const MCP_START_FAILURE_COOLDOWN_MS = 60_000
// The control plane caps a terminal command result at 64 KiB
// (executor-command-results.ts MAX_RESULT_BYTES). A Kelpie full-page
// screenshot is a base64 PNG, typically 0.5–3 MiB, so it can never fit: an
// oversize result is refused with a named code and its size rather than
// truncated, because truncated base64 decodes as a corrupt image that looks
// like a server bug instead of a stated limit.
const MCP_RESULT_MAX_BYTES = 65_536

export type ExecutorMcpFailure = {
  code: string
  message: string
  /**
   * Why the server could not be reached, when the failure was a start
   * failure. It rides the failure because `probe` reports this category to
   * Nessie and a caller that only sees the message cannot recover it —
   * "not installed" and "installed but it died" send a person to opposite
   * actions, so collapsing them defeats the report.
   */
  reason?: ExecutorMcpUnavailableReason
  success: false
}

export type ExecutorMcpProbeOutcome =
  | {
    available: true
    catalogDigest: string
    serverVersion?: string
    toolCount: number
  }
  | {
    available: false
    reason: ExecutorMcpUnavailableReason
  }

export type ExecutorMcpSessionManager = {
  listTools: (server: string, cursor?: string) => Promise<Record<string, unknown>>
  callTool: (server: string, tool: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>
  probe: (server: string) => Promise<ExecutorMcpProbeOutcome>
  stopAll: () => Promise<void>
}

type SessionCatalog = {
  content: { server: string; serverVersion?: string; tools: ExecutorMcpTool[] }
  digest: string
}

type ActiveSession = {
  catalog?: SessionCatalog
  client: Client
  dead: boolean
  idleTimer?: NodeJS.Timeout
  pending: number
  queue: Promise<void>
}

type StartFailure = {
  consecutive: number
  notBefore: number
}

const failure = (code: string, message: string): ExecutorMcpFailure => ({ code, message, success: false })

const denied = (error: ExecutorMcpServerError): ExecutorMcpFailure => failure('EXECUTOR_MCP_DENIED', error.message)

const unavailable = (
  message: string,
  reason?: ExecutorMcpUnavailableReason,
): ExecutorMcpFailure => ({
  code: 'EXECUTOR_MCP_UNAVAILABLE',
  message,
  ...(reason === undefined ? {} : { reason }),
  success: false,
})

/**
 * What the failure tells Nessie. The server's *name* and a reason category
 * are all that may travel: the underlying error carries the launch spec —
 * argv, a host path, an environment value — which never leaves the machine.
 * The full error goes to the daemon's local log instead.
 */
const startFailureMessage = (server: string, reason: ExecutorMcpUnavailableReason): string => {
  if (reason === 'not_installed') {
    return `The MCP server "${server}" is not installed — its program was not found.`
  }
  if (reason === 'launch_failed') {
    return `The MCP server "${server}" exited during startup.`
  }
  return `The MCP server "${server}" did not complete the MCP handshake.`
}

const withTimeout = async <T>(work: Promise<T>, timeoutMs: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Owns one MCP client session per policy-named server. One session per server
 * — never per call, never per run: stdio is a single duplex that will not
 * tolerate interleaved misuse, so requests for a server serialize on its
 * session's queue while different servers proceed in parallel.
 */
export const createExecutorMcpSessionManager = (
  servers: readonly ExecutorLocalMcpServer[],
  limits: { maxResultBytes: number },
  options: {
    idleTimeoutMs?: number
    log?: (message: string, cause: unknown) => void
    startCooldownMs?: number
    startTimeoutMs?: number
  } = {},
): ExecutorMcpSessionManager => {
  const idleTimeoutMs = options.idleTimeoutMs ?? MCP_SESSION_IDLE_TIMEOUT_MS
  const startCooldownMs = options.startCooldownMs ?? MCP_START_FAILURE_COOLDOWN_MS
  const startTimeoutMs = options.startTimeoutMs ?? MCP_SESSION_START_TIMEOUT_MS
  const log = options.log ?? ((message: string, cause: unknown) => {
    console.error(`[nessie-executor] ${message}:`, cause instanceof Error ? cause.message : String(cause))
  })
  const maxResultBytes = Math.min(limits.maxResultBytes, MCP_RESULT_MAX_BYTES)
  const sessions = new Map<string, ActiveSession>()
  const startFailures = new Map<string, StartFailure>()

  const closeSession = (server: string, session: ActiveSession): void => {
    if (sessions.get(server) !== session) return
    sessions.delete(server)
    clearTimeout(session.idleTimer)
    session.dead = true
    void session.client.close().catch(() => undefined)
  }

  const armIdleTimer = (server: string, session: ActiveSession): void => {
    if (session.dead || session.pending > 0) return
    clearTimeout(session.idleTimer)
    session.idleTimer = setTimeout(() => closeSession(server, session), idleTimeoutMs)
  }

  const classifyStartFailure = (
    spawnError: (Error & { code?: string }) | undefined,
    exited: boolean,
  ): ExecutorMcpUnavailableReason => {
    if (spawnError?.code === 'ENOENT') return 'not_installed'
    if (exited) return 'launch_failed'
    return 'handshake_failed'
  }

  const noteStartFailure = (server: string): void => {
    const previous = startFailures.get(server)
    const consecutive = (previous?.consecutive ?? 0) + 1
    startFailures.set(server, {
      consecutive,
      notBefore: consecutive >= MCP_START_FAILURE_THRESHOLD
        ? Date.now() + startCooldownMs
        : 0,
    })
  }

  const startSession = async (
    spec: ExecutorLocalMcpServer,
  ): Promise<ActiveSession | ExecutorMcpUnavailableReason> => {
    const backoff = startFailures.get(spec.name)
    if (backoff && backoff.notBefore > Date.now()) {
      return 'handshake_failed'
    }
    const client = new Client(
      { name: 'nessie-executor', version: '1' },
      { capabilities: {} },
    )
    const transport = new StdioClientTransport({
      args: spec.command.slice(1),
      command: spec.command[0] ?? '',
      ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      // The transport layers this over its safe default set (PATH, HOME, …),
      // so a server gets only the environment the policy spells out.
      ...(spec.env === undefined ? {} : { env: spec.env }),
      stderr: 'inherit',
    })
    let spawnError: (Error & { code?: string }) | undefined
    let exited = false
    transport.onerror = (error: Error) => {
      spawnError ??= error
    }
    transport.onclose = () => {
      exited = true
    }
    const session: ActiveSession = {
      client,
      dead: false,
      pending: 0,
      queue: Promise.resolve(),
    }
    client.onclose = () => {
      // A crash is noticed here: the session is dropped, its in-flight call
      // has already been rejected by the SDK, and the next request starts a
      // fresh process — subject to the crash-loop cooldown.
      if (sessions.get(spec.name) === session) closeSession(spec.name, session)
    }
    try {
      await withTimeout(client.connect(transport), startTimeoutMs)
    } catch (error) {
      const reason = classifyStartFailure(spawnError, exited)
      log(`local MCP server "${spec.name}" failed to start (${reason})`, error)
      noteStartFailure(spec.name)
      // The transport is closed as well as the client. A connect that never
      // completed leaves the client with no transport to close, so closing
      // only the client leaks the pipe — which keeps the daemon's event loop
      // alive forever after a server that will not start.
      await Promise.allSettled([client.close(), transport.close()])
      return reason
    }
    startFailures.delete(spec.name)
    sessions.set(spec.name, session)
    return session
  }

  /**
   * Runs `work` as the one in-flight request on the server's session. The
   * policy check happens here — before any process starts — so no path to a
   * session can reach a server the reviewed policy did not name.
   */
  const withSession = async <T>(
    server: string,
    work: (session: ActiveSession) => Promise<T>,
  ): Promise<T | ExecutorMcpFailure> => {
    let spec: ExecutorLocalMcpServer
    try {
      spec = findExecutorLocalMcpServer(servers, server)
    } catch (error) {
      return denied(error as ExecutorMcpServerError)
    }
    let session = sessions.get(server)
    if (!session || session.dead) {
      const started = await startSession(spec)
      if (typeof started === 'string') {
        return unavailable(startFailureMessage(server, started), started)
      }
      session = started
    }
    const active = session
    clearTimeout(active.idleTimer)
    active.pending += 1
    const run = active.queue.then(() => work(active))
    active.queue = run.then(() => undefined, () => undefined)
    try {
      return await run
    } finally {
      active.pending -= 1
      armIdleTimer(server, active)
    }
  }

  const loadCatalog = async (
    session: ActiveSession,
    server: string,
  ): Promise<SessionCatalog | ExecutorMcpFailure> => {
    if (session.catalog) return session.catalog
    const tools: ExecutorMcpTool[] = []
    let cursor: string | undefined
    // The daemon walks the server's own pagination so the digest below covers
    // the whole catalog and stays identical across the pages it then serves.
    do {
      let page
      try {
        page = await session.client.listTools(
          cursor === undefined ? undefined : { cursor },
          { timeout: MCP_CALL_TIMEOUT_MS },
        )
      } catch (error) {
        log(`local MCP server "${server}" refused tools/list`, error)
        return unavailable(`The MCP server "${server}" did not answer tools/list.`)
      }
      for (const tool of page.tools) {
        tools.push({
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
          inputSchema: tool.inputSchema as Record<string, unknown>,
        })
      }
      if (tools.length > EXECUTOR_MCP_TOOL_MAXIMUM) {
        return failure(
          'EXECUTOR_MCP_CATALOG_TOO_LARGE',
          `The MCP server "${server}" offers more than ${EXECUTOR_MCP_TOOL_MAXIMUM} tools.`,
        )
      }
      cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined
    } while (cursor !== undefined)
    const serverVersion = session.client.getServerVersion()?.version
    const content: SessionCatalog['content'] = {
      server,
      ...(serverVersion === undefined ? {} : { serverVersion }),
      tools,
    }
    const catalog: SessionCatalog = {
      content,
      digest: `sha256:${createHash('sha256').update(canonicalExecutorJson(content)).digest('hex')}`,
    }
    session.catalog = catalog
    return catalog
  }

  /**
   * One page of the full catalog, sized so the result document fits the
   * terminal-result budget; `cursor` is the opaque offset a previous page
   * returned. The digest never changes between pages of one catalog.
   */
  const catalogPage = (
    catalog: SessionCatalog,
    cursor: string | undefined,
  ): Record<string, unknown> => {
    const offset = cursor === undefined ? 0 : Number.parseInt(cursor, 10)
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > catalog.content.tools.length) {
      return failure('EXECUTOR_MCP_CURSOR_INVALID', 'The catalog cursor does not name a page.')
    }
    // The 1 KiB reserve covers the success flag, the catalog envelope and the
    // cursor inside the terminal-result budget.
    const budget = Math.max(1_024, maxResultBytes - 1_024)
    const fixed = Buffer.byteLength(JSON.stringify({
      server: catalog.content.server,
      serverVersion: catalog.content.serverVersion,
      digest: catalog.digest,
    }))
    let used = fixed
    const tools: ExecutorMcpTool[] = []
    for (const tool of catalog.content.tools.slice(offset)) {
      const size = Buffer.byteLength(JSON.stringify(tool)) + 1
      if (tools.length > 0 && used + size > budget) break
      used += size
      tools.push(tool)
    }
    const nextOffset = offset + tools.length
    const document: ExecutorMcpToolCatalog = {
      ...catalog.content,
      tools,
      digest: catalog.digest,
      ...(nextOffset < catalog.content.tools.length ? { nextCursor: String(nextOffset) } : {}),
    }
    return { catalog: document, success: true }
  }

  return {
    listTools: (server, cursor) => withSession(server, async (session) => {
      const catalog = await loadCatalog(session, server)
      if ('code' in catalog) return catalog
      return catalogPage(catalog, cursor)
    }),
    callTool: (server, tool, args) => withSession(server, async (session) => {
      let result
      try {
        result = await session.client.callTool(
          { name: tool, ...(args === undefined ? {} : { arguments: args }) },
          undefined,
          { timeout: MCP_CALL_TIMEOUT_MS },
        )
      } catch (error) {
        if (session.dead) {
          log(`local MCP server "${server}" died during tools/call`, error)
          return unavailable(`The MCP server "${server}" stopped during the call.`)
        }
        log(`local MCP server "${server}" failed tools/call`, error)
        return failure(
          'EXECUTOR_MCP_CALL_FAILED',
          `The MCP server "${server}" refused the call to "${tool}".`,
        )
      }
      const document: Record<string, unknown> = { ...result, success: true }
      const resultBytes = Buffer.byteLength(JSON.stringify(document))
      if (resultBytes > maxResultBytes) {
        return {
          code: 'EXECUTOR_MCP_RESULT_TOO_LARGE',
          maxResultBytes,
          message: `The MCP server "${server}" answered with ${resultBytes} bytes, over the ${maxResultBytes}-byte result budget.`,
          resultBytes,
          success: false,
        }
      }
      if ((result as { isError?: boolean }).isError === true) {
        return { ...result, code: 'EXECUTOR_MCP_CALL_FAILED', success: false }
      }
      return document
    }),
    probe: async (server) => {
      const outcome = await withSession(server, async (session) => loadCatalog(session, server))
      if ('code' in outcome) {
        if (outcome.code === 'EXECUTOR_MCP_DENIED') return { available: false, reason: 'not_probed' as const }
        // A start failure already decided why; only a server that started and
        // then refused tools/list is a handshake failure.
        return { available: false, reason: outcome.reason ?? 'handshake_failed' }
      }
      return {
        available: true,
        catalogDigest: outcome.digest,
        ...(outcome.content.serverVersion === undefined
          ? {}
          : { serverVersion: outcome.content.serverVersion }),
        toolCount: outcome.content.tools.length,
      }
    },
    stopAll: async () => {
      const active = [...sessions.entries()]
      for (const [server, session] of active) closeSession(server, session)
    },
  }
}
