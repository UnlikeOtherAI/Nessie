import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { createCodingBridge, type CodingBridgeCallMeta } from './bridge.js'
import { codingBridgeTools, CodingBridgeError } from './bridge-tools.js'
import { loadCodingSessionsConfig } from './config.js'
import { CODING_SESSION_COMMAND_META, CODING_SESSION_DAEMON_CONTROL_META, CODING_SESSION_OWNER_META } from './meta-keys.js'

/**
 * `nessie-executor serve-coding-session-mcp --config <abs path>`: the
 * coding-sessions bridge as an MCP stdio server, on the official SDK like
 * `serve-ollama-search-mcp`.
 *
 * The daemon passes the model's `arguments` untouched and sets three reserved
 * `_meta` keys the model cannot reach, on calls to this built-in bridge only:
 * the owner key, the executor command id (which makes a replayed call a no-op),
 * and the daemon-control marker that only the daemon's own teardown calls
 * carry. Every answer is rewritten once more on its way out, string by string,
 * so no host path survives even in text the bridge itself composed.
 */
export { CODING_SESSION_COMMAND_META, CODING_SESSION_DAEMON_CONTROL_META, CODING_SESSION_OWNER_META }

export const codingBridgeCallMeta = (meta: unknown): CodingBridgeCallMeta => {
  const fields = meta && typeof meta === 'object' ? meta as Record<string, unknown> : {}
  const owner = fields[CODING_SESSION_OWNER_META]
  const command = fields[CODING_SESSION_COMMAND_META]
  return {
    ...(typeof owner === 'string' ? { ownerKey: owner } : {}),
    ...(typeof command === 'string' ? { commandId: command } : {}),
    daemonControl: fields[CODING_SESSION_DAEMON_CONTROL_META] === true,
  }
}

const rewriteStrings = (value: unknown, rewrite: (text: string) => string): unknown => {
  if (typeof value === 'string') return rewrite(value)
  if (Array.isArray(value)) return value.map((entry) => rewriteStrings(entry, rewrite))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewriteStrings(entry, rewrite)]))
  }
  return value
}

export const serveCodingSessionMcp = async (configPath: string): Promise<void> => {
  const loaded = await loadCodingSessionsConfig(configPath)
  const bridge = await createCodingBridge(loaded)
  const tools = codingBridgeTools(loaded)
  const server = new Server({ name: 'nessie-coding-sessions', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const meta = codingBridgeCallMeta(request.params._meta)
    try {
      const result = await bridge.call(request.params.name, request.params.arguments, meta)
      return { content: [{ type: 'text', text: JSON.stringify(rewriteStrings(result, bridge.rewrite)) }] }
    } catch (error) {
      const known = error instanceof CodingBridgeError
      // The full error stays in the daemon's local log; only a code and fixed text travel.
      if (!known) process.stderr.write(`[coding-sessions] ${error instanceof Error ? error.message : String(error)}\n`)
      const answer = {
        code: known ? error.code : 'coding_session_unavailable',
        message: known ? error.message : 'The coding-sessions bridge could not complete that call.',
      }
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(rewriteStrings(answer, bridge.rewrite)) }] }
    }
  })
  await server.connect(new StdioServerTransport())
}
