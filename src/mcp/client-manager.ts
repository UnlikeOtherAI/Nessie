/**
 * src/mcp/client-manager.ts — MCP Client Manager for connecting to external MCP servers.
 * Manages connections, tool registry, and workspace boundary security.
 */

import { spawn, ChildProcess } from 'child_process'
import { McpServerConfig, McpTool, McpClientState } from './client-types.js'

// Workspace boundary - restricts MCP server access to allowed paths
interface WorkspaceBoundary {
  allowedPaths: string[]
  deniedPaths: string[]
}

const DEFAULT_WORKSPACE_BOUNDARY: WorkspaceBoundary = {
  allowedPaths: [],
  deniedPaths: ['/etc', '/root', '/home/*/.ssh', '/home/*/.gnupg'],
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
   * Connect to a stdio-based MCP server
   */
  private async connectStdio(name: string, config: McpServerConfig): Promise<void> {
    const entry = this.servers.get(name)
    if (!entry) return

    return new Promise((resolve, reject) => {
      const child = spawn(config.command!, config.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...config.env,
        },
      })

      entry.process = child

      let stdout = ''
      let stderr = ''

      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
        // Try to parse tool manifest
        this.handleServerMessage(name, stdout)
      })

      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
        console.warn(`[McpClient:${name}] stderr:`, data.toString())
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

      setTimeout(() => {
        if (child.stdin) {
          child.stdin.write(JSON.stringify(initRequest) + '\n')
          entry.state.connected = true
          resolve()
        }
      }, 100)
    })
  }

  /**
   * Handle messages from MCP server
   */
  private handleServerMessage(name: string, data: string): void {
    const entry = this.servers.get(name)
    if (!entry) return

    try {
      const msg = JSON.parse(data)
      if (msg.result?.tools) {
        entry.state.tools = msg.result.tools as McpTool[]
        console.log(`[McpClient:${name}] Received ${entry.state.tools.length} tools`)
      }
    } catch {
      // Not a JSON message or not yet complete
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
        const id = `call-${Date.now()}`
        const request = {
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: args,
          },
        }

        let responseData = ''

        const onData = (data: Buffer) => {
          responseData += data.toString()
          try {
            const response = JSON.parse(responseData)
            if (response.id === id) {
              entry.process!.stdout?.removeListener('data', onData)
              if (response.error) {
                reject(new Error(response.error.message))
              } else {
                resolve(response.result)
              }
            }
          } catch {
            // Not complete yet
          }
        }

        entry.process!.stdout?.on('data', onData)
        entry.process!.stdin?.write(JSON.stringify(request) + '\n')

        // Timeout after 30 seconds
        setTimeout(() => {
          entry.process!.stdout?.removeListener('data', onData)
          reject(new Error('Tool call timed out'))
        }, 30000)
      })
    }

    throw new Error(`Transport ${entry.config.transport} not supported for tool calls`)
  }

  /**
   * Validate that arguments don't access denied paths
   */
  private validateWorkspaceBoundary(args: Record<string, unknown>): void {
    const checkPath = (path: unknown): void => {
      if (typeof path !== 'string') return

      // Check denied paths
      for (const denied of this.boundary.deniedPaths) {
        if (path.startsWith(denied)) {
          throw new Error(`Access denied: ${path}`)
        }
      }

      // If allowedPaths is set, check the path is within allowed
      if (this.boundary.allowedPaths.length > 0) {
        const withinAllowed = this.boundary.allowedPaths.some(allowed =>
          path.startsWith(allowed) || path.startsWith(this.workspaceRoot)
        )
        if (!withinAllowed) {
          throw new Error(`Path outside workspace boundary: ${path}`)
        }
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
    if (entry?.process) {
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
