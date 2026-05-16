import { randomUUID } from 'node:crypto'

import { McpConnection } from './client.js'
import { McpNotConnectedError } from './errors.js'
import type {
  McpConnectionId,
  McpConnectionSpec,
  McpConnectionState,
  McpEventCallback,
  McpEventName,
  McpHealth,
  McpManagerEvent,
  McpToolDescriptor,
  McpToolResult,
  Unsubscribe,
} from './types.js'

type ListenerSet = {
  state: Set<McpEventCallback<'state'>>
  error: Set<McpEventCallback<'error'>>
  notification: Set<McpEventCallback<'notification'>>
}

/**
 * Universal MCP client. One instance per process is plenty — open as many
 * connections through it as you need.
 *
 * Lifecycle: `open(spec)` returns a branded id; the id is the only thing the
 * caller ever uses afterwards. Closing is idempotent.
 *
 * No DB, no Nessie-internal types, no credential resolution — pass resolved
 * headers/env in the spec and that's it.
 */
export class McpClientManager {
  private readonly connections = new Map<McpConnectionId, McpConnection>()

  private readonly listeners: ListenerSet = {
    state: new Set(),
    error: new Set(),
    notification: new Set(),
  }

  async open(spec: McpConnectionSpec): Promise<McpConnectionId> {
    const id = randomUUID() as McpConnectionId
    const conn = new McpConnection(id, spec, {
      onState: (state) => this.emitState(id, state),
      onError: (error) => this.emitError(id, error),
      onNotification: (method, params) => this.emitNotification(id, method, params),
    })
    this.connections.set(id, conn)
    try {
      await conn.open()
    } catch (err) {
      this.connections.delete(id)
      throw err
    }
    return id
  }

  async close(id: McpConnectionId): Promise<void> {
    const conn = this.connections.get(id)
    if (!conn) return
    this.connections.delete(id)
    await conn.close()
  }

  async listTools(id: McpConnectionId): Promise<McpToolDescriptor[]> {
    return this.requireConnection(id).listTools(false)
  }

  /** Force a fresh `tools/list` round-trip, bypassing the discovery cache. */
  async refresh(id: McpConnectionId): Promise<McpToolDescriptor[]> {
    return this.requireConnection(id).listTools(true)
  }

  async callTool(
    id: McpConnectionId,
    name: string,
    args: unknown,
    opts?: { timeoutMs?: number; abort?: AbortSignal },
  ): Promise<McpToolResult> {
    return this.requireConnection(id).callTool(name, args, opts)
  }

  async health(id: McpConnectionId): Promise<McpHealth> {
    return this.requireConnection(id).health()
  }

  /**
   * Attempt to reconnect an existing connection after a transport drop.
   * Resolves to `true` once the connection is ready again, or `false` once the
   * backoff budget is exhausted and the connection is left in `failed` state.
   */
  async reconnect(id: McpConnectionId): Promise<boolean> {
    return this.requireConnection(id).reconnect()
  }

  on<E extends McpEventName>(event: E, cb: McpEventCallback<E>): Unsubscribe {
    const bucket = this.listeners[event] as unknown as Set<McpEventCallback<E>>
    bucket.add(cb)
    return () => {
      bucket.delete(cb)
    }
  }

  /** Close every open connection. Used at process shutdown. */
  async closeAll(): Promise<void> {
    const ids = Array.from(this.connections.keys())
    await Promise.all(ids.map((id) => this.close(id)))
  }

  private requireConnection(id: McpConnectionId): McpConnection {
    const conn = this.connections.get(id)
    if (!conn) {
      throw new McpNotConnectedError(`unknown mcp connection: ${id}`)
    }
    return conn
  }

  private emitState(id: McpConnectionId, state: McpConnectionState): void {
    const event: McpManagerEvent = { type: 'state', id, state }
    for (const cb of this.listeners.state) cb(event)
  }

  private emitError(id: McpConnectionId, error: Error): void {
    const event: McpManagerEvent = { type: 'error', id, error }
    for (const cb of this.listeners.error) cb(event)
  }

  private emitNotification(id: McpConnectionId, method: string, params: unknown): void {
    const event: McpManagerEvent = { type: 'notification', id, method, params }
    for (const cb of this.listeners.notification) cb(event)
  }
}
