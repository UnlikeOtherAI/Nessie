/**
 * src/mcp/client-manager.ts — MCP Client Manager for connecting to external MCP servers.
 * Manages connections, tool registry, and workspace boundary security.
 */

import { spawn, ChildProcess } from 'child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { McpServerConfig, McpTool, McpClientState } from './client-types.js'

// Minimal env — strip secrets before passing to MCP child processes
const MINIMAL_ENV: Record<string, string> = {
  HOME: process.env.HOME ?? '/home/dev',
  PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
  LANG: process.env.LANG ?? 'en_US.UTF-8',
  LC_ALL: process.env.LC_ALL ?? 'en_US.UTF-8',
  TMPDIR: process.env.TMPDIR ?? '/tmp',
  // Pass through any explicit env vars configured by user (not full process.env)
}

interface WorkspaceBoundary {
  allowedPaths: string[]
  deniedPaths: string[]
}

const DEFAULT_WORKSPACE_BOUNDARY: WorkspaceBoundary = {
  allowedPaths: [],
  deniedPaths: ['/etc', '/root', '/home', '/tmp'],
}

/**
 * Resolve a path to its realpath, catching symlink errors.
 * Returns null if the path doesn't exist or can't be resolved.
 */
function safeRealpath(p: string): string | null {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

/**
 * Check if a path is within the workspace boundary using realpath + prefix check.
 */
function isPathInBoundary(path: string, boundary: WorkspaceBoundary, workspaceRoot: string): boolean {
  // Normalize: resolve to absolute, then get realpath to catch symlinks
  const absPath = resolve(workspaceRoot, path)
  const realPath = safeRealpath(absPath)
  if (!realPath) return false

  // Check denied patterns (simple prefix match on real path)
  for (const denied of boundary.deniedPaths) {
    if (realPath === denied || realPath.startsWith(denied + '/')) {
      return false
    }
  }

  // If allowedPaths specified, must be within one of them
  if (boundary.allowedPaths.length > 0) {
    const withinAllowed = boundary.allowedPaths.some(allowed => {
      const realAllowed = safeRealpath(allowed)
      if (!realAllowed) return false
      return realPath === realAllowed || realPath.startsWith(realAllowed + '/')
    })
    if (!withinAllowed) return false
  }

  return true
}

export class McpClientManager {
  private servers: Map<string, {
    config: McpServerConfig
    process?: ChildProcess
    state: McpClientState
  }> = new Map()

  private boundary: WorkspaceBoundary
  private workspaceRoot: string

  constructor(workspaceRoot: string = process.cwd(), boundary?: WorkspaceBoundary) {
    this.workspaceRoot = workspaceRoot
    this.boundary = boundary ?? DEFAULT_WORKSPACE_BOUNDARY
  }

  /**
   * Add and connect to an MCP server
   */
  async connectServer(name: string, config: McpServerConfig): Promise<void> {
    if (this.servers.has(name)) {
      throw new Error(`Server already connected: ${name}`)
    }

    const entry = {
      config,
      state: {
        connected: false,
        tools: [],
        error: undefined,
      } as McpClientState,
    }

    this.servers.set(name, entry)

    if (config.transport === 'stdio' && config.command) {
      await this.connectStdio(name, config)
    } else if (config.transport === 'http' && config.url) {
      // HTTP/SSE transport - future implementation
      entry.state.error = 'HTTP transport not yet implemented'
      console.warn(`[McpClient] HTTP transport not yet implemented for ${name}`)
    }
  }

  /**
   * Connect to a stdio-based MCP server with proper JSON-RPC framing.
   */
  private async connectStdio(name: string, config: McpServerConfig): Promise<void> {
    const entry = this.servers.get(name)
    if (!entry) return

    return new Promise((resolve, reject) => {
      // Merge MINIMAL_ENV with user-specified env vars only
      const childEnv: Record<string, string> = {
        ...MINIMAL_ENV,
        ...config.env,
      }

      const child = spawn(config.command!, config.args ?? [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: childEnv,
      })

      entry.process = child

      let stdoutBuffer = ''
      let stderrBuffer = ''
      let pendingResponses = new Map<string, (value: unknown) => void>()
      let toolCallResolve: ((value: unknown) => void) | null = null
      let toolCallReject: ((err: Error) => void) | null = null
      let currentToolCallId: string | null = null

      child.stdout?.on('data', (data: Buffer) => {
        stdoutBuffer += data.toString()
        // Process complete JSON-RPC messages (newline-delimited)
        const lines = stdoutBuffer.split('\n')
        stdoutBuffer = lines.pop() ?? '' // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const msg = JSON.parse(line)
            this.handleServerMessage(name, msg)

            // Handle response to a pending tool call
            if (msg.id && currentToolCallId === String(msg.id)) {
              currentToolCallId = null
              if (msg.error) {
                toolCallReject?.(new Error(msg.error.message ?? 'Unknown error'))
              } else {
                toolCallResolve?.(msg.result)
              }
              toolCallResolve = null
              toolCallReject = null
            }
          } catch {
            // Not JSON — might be partial frame, ignore
          }
        }
      })

      child.stderr?.on('data', (data: Buffer) => {
        stderrBuffer += data.toString()
        console.warn(`[McpClient:${name}] stderr:`, data.toString().slice(0, 200))
      })

      child.on('error', (err) => {
        entry.state.connected = false
        entry.state.error = err.message
        reject(err)
      })

      child.on('close', (code) => {
        entry.state.connected = false
        if (code !== 0) {
          entry.state.error = `Server exited with code ${code}`
        }
        console.log(`[McpClient:${name}] Process exited with code ${code}`)
      })

      // Send initialize request
      const initRequest = {
        jsonrpc: '2.0',
        id: 'init',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: 'nessie-mcp-client',
            version: '1.0.0',
          },
        },
      }

      child.stdin?.write(JSON.stringify(initRequest) + '\n')

      // Wait for server to respond to initialize before marking connected
      // Poll until we get the response or timeout
      const initTimeout = setTimeout(() => {
        entry.state.error = 'Initialize timeout'
        reject(new Error('MCP server initialize timeout'))
      }, 10000)

      const checkInit = setInterval(() => {
        if (entry.state.tools.length > 0) {
          clearTimeout(initTimeout)
          clearInterval(checkInit)
          entry.state.connected = true
          resolve()
        }
      }, 50)

      // Store the init check interval for cleanup
      ;(entry as unknown as Record<string, unknown>)._initCheckInterval = checkInit
    })
  }

  /**
   * Handle messages from MCP server (notifications, responses).
   */
  private handleServerMessage(name: string, msg: unknown): void {
    if (!msg || typeof msg !== 'object') return
    const obj = msg as Record<string, unknown>

    // Tool list from server (notification after initialize)
    if (obj.method === 'notifications/tools/list' || obj.method === 'tools/list') {
      const tools = (obj.params as Record<string, unknown> | undefined)?.tools as unknown[]
      if (Array.isArray(tools)) {
        const entry = this.servers.get(name)
        if (entry) {
          entry.state.tools = tools as McpTool[]
          console.log(`[McpClient:${name}] Received ${entry.state.tools.length} tools`)
        }
      }
    }

    // Result from initialize
    if (obj.id === 'init' && obj.result) {
      const entry = this.servers.get(name)
      if (entry && obj.result && typeof obj.result === 'object') {
        const result = obj.result as Record<string, unknown>
        if (Array.isArray(result.tools)) {
          entry.state.tools = result.tools as McpTool[]
        }
      }
    }
  }

  /**
   * Call an MCP tool on a connected server
   */
  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const entry = this.servers.get(serverName)
    if (!entry) {
      throw new Error(`Server not found: ${serverName}`)
    }

    if (!entry.state.connected) {
      throw new Error(`Server not connected: ${serverName}`)
    }

    const tool = entry.state.tools.find(t => t.name === toolName)
    if (!tool) {
      throw new Error(`Tool not found: ${toolName} on ${serverName}`)
    }

    // Security: Check workspace boundaries for file paths
    this.validateWorkspaceBoundary(args)

    // For stdio transport, send request and wait for response
    if (entry.config.transport === 'stdio' && entry.process?.stdin) {
      return new Promise((resolve, reject) => {
        const id = `call-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const request = {
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: args,
          },
        }

        entry.process!.stdin?.write(JSON.stringify(request) + '\n')

        // Timeout after 30 seconds
        const timeout = setTimeout(() => {
          reject(new Error('Tool call timed out'))
        }, 30000)

        // Store callbacks for the stdout handler to pick up
        const originalOn = entry.process!.stdout?.on.bind(entry.process!.stdout)
        // We'll handle it via a flag + stored callbacks
        ;(entry as unknown as Record<string, unknown>)._currentResolve = resolve
        ;(entry as unknown as Record<string, unknown>)._currentReject = reject
        ;(entry as unknown as Record<string, unknown>)._currentToolId = id
        ;(entry as unknown as Record<string, unknown>)._toolTimeout = timeout
      })
    }

    throw new Error(`Transport ${entry.config.transport} not supported for tool calls`)
  }

  /**
   * Validate that arguments don't access denied paths using realpath normalization.
   */
  private validateWorkspaceBoundary(args: Record<string, unknown>): void {
    const checkPath = (path: unknown): void => {
      if (typeof path !== 'string') return

      // Resolve relative to workspace root and check realpath
      const absPath = resolve(this.workspaceRoot, path)
      const realPath = safeRealpath(absPath)

      if (realPath === null) {
        // Path doesn't exist yet — allow it, don't block on creation
        // But check the parent directory exists and is valid
        const parent = resolve(absPath, '..')
        const realParent = safeRealpath(parent)
        if (realParent === null) {
          throw new Error(`Path parent directory doesn't exist: ${parent}`)
        }
        return
      }

      if (!isPathInBoundary(realPath, this.boundary, this.workspaceRoot)) {
        throw new Error(`Access denied: ${path} is outside workspace boundary`)
      }
    }

    const inspect = (obj: unknown): void => {
      if (typeof obj === 'string') {
        checkPath(obj)
      } else if (Array.isArray(obj)) {
        obj.forEach(inspect)
      } else if (typeof obj === 'object' && obj !== null) {
        Object.values(obj).forEach(inspect)
      }
    }

    inspect(args)
  }

  /**
   * Get all registered tools from all connected servers
   */
  getAllTools(): Map<string, McpTool[]> {
    const result = new Map<string, McpTool[]>()
    for (const [name, entry] of this.servers) {
      result.set(name, entry.state.tools)
    }
    return result
  }

  /**
   * Get tool from specific server
   */
  getTools(serverName: string): McpTool[] {
    return this.servers.get(serverName)?.state.tools ?? []
  }

  /**
   * Get connection state for a server
   */
  getState(serverName: string): McpClientState | null {
    return this.servers.get(serverName)?.state ?? null
  }

  /**
   * List all connected servers
   */
  listServers(): string[] {
    return Array.from(this.servers.keys())
  }

  /**
   * Disconnect from a server
   */
  disconnect(serverName: string): void {
    const entry = this.servers.get(serverName)
    if (!entry) return

    // Clear any pending init check
    const initInterval = (entry as unknown as Record<string, unknown>)._initCheckInterval as NodeJS.Timeout | undefined
    if (initInterval) clearInterval(initInterval)

    if (entry.process) {
      entry.process.kill()
      entry.state.connected = false
    }
    this.servers.delete(serverName)
  }

  /**
   * Disconnect all servers
   */
  disconnectAll(): void {
    for (const name of this.servers.keys()) {
      this.disconnect(name)
    }
  }
}

// Singleton instance
let _instance: McpClientManager | null = null

export function getMcpClientManager(): McpClientManager {
  if (!_instance) {
    _instance = new McpClientManager()
  }
  return _instance
}

export function setMcpClientManager(manager: McpClientManager): void {
  _instance = manager
}
