import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { McpStdioSpec } from '../types.js'

/**
 * Build a stdio transport for the official MCP SDK from a Nessie spec.
 *
 * The SDK spawns the child process; we pass the caller's `env` through
 * untouched (no merging with `process.env` here — credential injection is the
 * caller's responsibility and we don't want to leak ambient secrets).
 */
export function createStdioTransport(spec: McpStdioSpec): StdioClientTransport {
  return new StdioClientTransport({
    command: spec.command,
    args: spec.args ?? [],
    env: spec.env,
    cwd: spec.cwd,
    stderr: 'pipe',
  })
}
