import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { Backoff, sleep } from './backoff.js'
import { DiscoveryCache, normaliseTools } from './discovery.js'
import {
  McpNotConnectedError,
  McpTimeoutError,
  McpTransportError,
  classifyError,
} from './errors.js'
import { createHttpTransport } from './transport/http.js'
import { createSseTransport } from './transport/sse.js'
import { createStdioTransport } from './transport/stdio.js'
import type {
  McpConnectionId,
  McpConnectionSpec,
  McpConnectionState,
  McpHealth,
  McpToolDescriptor,
  McpToolResult,
} from './types.js'

const CLIENT_NAME = '@nessie/mcp-client'
const CLIENT_VERSION = '0.0.0'

const DEFAULT_CALL_TIMEOUT_MS = 30_000

export type ConnectionListener = {
  onState: (state: McpConnectionState) => void
  onError: (err: Error) => void
  onNotification: (method: string, params: unknown) => void
}

/**
 * Single MCP connection. Wraps the official `Client`, owns its transport, and
 * exposes only the operations the manager needs. All public surface goes
 * through the manager — this class is intentionally not exported from the
 * package barrel.
 */
export class McpConnection {
  private client: Client | null = null

  private state: McpConnectionState = 'connecting'

  private lastPingOk: boolean | null = null

  private lastPingAt: number | null = null

  private consecutiveFailures = 0

  private readonly backoff = new Backoff()

  private readonly cache = new DiscoveryCache()

  constructor(
    public readonly id: McpConnectionId,
    private readonly spec: McpConnectionSpec,
    private readonly listener: ConnectionListener,
  ) {}

  /** Establish the initial connection. Errors are re-thrown classified. */
  async open(): Promise<void> {
    this.setState('connecting')
    try {
      await this.connectOnce()
      this.setState('ready')
      this.backoff.reset()
      this.consecutiveFailures = 0
    } catch (err) {
      this.setState('failed')
      throw classifyError(err)
    }
  }

  async close(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close()
      } catch {
        // best-effort close; the transport may already be torn down
      }
    }
    this.client = null
    this.cache.clear()
    this.setState('closed')
  }

  async listTools(refresh = false): Promise<McpToolDescriptor[]> {
    const client = this.requireClient()
    if (!refresh) {
      const cached = this.cache.get(this.id)
      if (cached) return cached
    }
    try {
      const raw = await client.listTools()
      const tools = normaliseTools(raw)
      this.cache.set(this.id, tools)
      return tools
    } catch (err) {
      throw classifyError(err)
    }
  }

  refresh(): void {
    this.cache.invalidate(this.id)
  }

  async callTool(
    name: string,
    args: unknown,
    opts: { timeoutMs?: number; abort?: AbortSignal } = {},
  ): Promise<McpToolResult> {
    const client = this.requireClient()
    const timeoutMs = opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
    const abort = opts.abort

    if (abort?.aborted) throw classifyError(abort.reason ?? new Error('aborted'))

    const params: { name: string; arguments?: Record<string, unknown> } = { name }
    if (args !== undefined && args !== null) {
      if (typeof args !== 'object') {
        throw classifyError(new Error('tool arguments must be an object or undefined'))
      }
      params.arguments = args as Record<string, unknown>
    }

    try {
      const result = await this.withTimeoutAndAbort(
        (signal) => client.callTool(params, undefined, { signal, timeout: timeoutMs }),
        timeoutMs,
        abort,
      )
      return normaliseCallResult(result)
    } catch (err) {
      throw classifyError(err)
    }
  }

  async health(): Promise<McpHealth> {
    if (this.client && this.state === 'ready') {
      try {
        await this.client.ping()
        this.lastPingOk = true
        this.lastPingAt = Date.now()
        this.consecutiveFailures = 0
      } catch {
        this.lastPingOk = false
        this.lastPingAt = Date.now()
        this.consecutiveFailures += 1
      }
    }
    return {
      id: this.id,
      state: this.state,
      lastPingOk: this.lastPingOk,
      lastPingAt: this.lastPingAt,
      consecutiveFailures: this.consecutiveFailures,
    }
  }

  /**
   * Attempt to reconnect using exponential backoff. Resolves to `true` once
   * the connection is ready again, or `false` once the budget is exhausted.
   * The connection state is updated as we go so callers (and listeners)
   * observe the lifecycle.
   */
  async reconnect(): Promise<boolean> {
    this.setState('reconnecting')
    // Tear down the previous client before we start dialing again so its
    // transport doesn't leak open sockets / file descriptors across attempts.
    if (this.client) {
      try {
        await this.client.close()
      } catch {
        // already dead — fine
      }
      this.client = null
    }
    while (true) {
      const delay = this.backoff.nextDelay()
      if (delay === null) {
        this.setState('failed')
        return false
      }
      try {
        await sleep(delay)
        await this.connectOnce()
        this.setState('ready')
        this.backoff.reset()
        this.consecutiveFailures = 0
        return true
      } catch (err) {
        this.consecutiveFailures += 1
        this.listener.onError(classifyError(err))
      }
    }
  }

  private requireClient(): Client {
    if (!this.client || this.state === 'closed' || this.state === 'failed') {
      throw new McpNotConnectedError(`mcp connection ${this.id} is not connected`)
    }
    return this.client
  }

  private setState(state: McpConnectionState): void {
    if (this.state === state) return
    this.state = state
    this.listener.onState(state)
  }

  private async connectOnce(): Promise<void> {
    const transport = this.buildTransport()
    const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION })
    transport.onclose = (): void => {
      // Surface unexpected closes so the manager can decide to reconnect.
      if (this.state !== 'closed' && this.state !== 'failed') {
        this.listener.onError(new McpTransportError(`transport for ${this.id} closed`))
        this.setState('reconnecting')
      }
    }
    transport.onerror = (err: Error): void => {
      this.listener.onError(classifyError(err))
    }
    transport.onmessage = (msg: unknown): void => {
      if (
        msg
        && typeof msg === 'object'
        && 'method' in msg
        && !('id' in msg)
      ) {
        const m = msg as { method: string; params?: unknown }
        this.listener.onNotification(m.method, m.params)
      }
    }
    await client.connect(transport)
    this.client = client
  }

  private buildTransport(): Transport {
    switch (this.spec.transport) {
      case 'stdio':
        return createStdioTransport(this.spec)
      case 'http':
        return createHttpTransport(this.spec)
      case 'sse':
        return createSseTransport(this.spec)
      default: {
        // Exhaustiveness; the type system already forbids other tags.
        const _exhaustive: never = this.spec
        return _exhaustive
      }
    }
  }

  private async withTimeoutAndAbort<T>(
    body: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    abort?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new McpTimeoutError(`tool call timed out after ${timeoutMs}ms`, timeoutMs)),
      timeoutMs,
    )
    const onUserAbort = (): void => {
      controller.abort(abort?.reason ?? new Error('aborted by caller'))
    }
    if (abort) abort.addEventListener('abort', onUserAbort, { once: true })
    try {
      return await body(controller.signal)
    } finally {
      clearTimeout(timer)
      if (abort) abort.removeEventListener('abort', onUserAbort)
    }
  }
}

function normaliseCallResult(raw: Record<string, unknown>): McpToolResult {
  const content = Array.isArray(raw.content) ? (raw.content as unknown[]) : []
  const result: McpToolResult = {
    isError: raw.isError === true,
    content,
  }
  if (raw.structuredContent && typeof raw.structuredContent === 'object') {
    result.structuredContent = raw.structuredContent as Record<string, unknown>
  }
  return result
}
