import { isAbsolute } from 'node:path'

import { serveCodingSessionMcp } from './coding-session/bridge-server.js'
import { runCodingSessionHost } from './coding-session/host.js'
import { serveOllamaSearchMcp } from './ollama-search-mcp.js'

/**
 * The MCP servers this executor ships itself, and the coding-session host the
 * coding bridge detaches. Each is started by the daemon (or by the bridge)
 * with an exact argv, so anything else on the command line is refused rather
 * than guessed at.
 */
const CODING_SESSION_MCP_USAGE = 'Usage: nessie-executor serve-coding-session-mcp --config <absolute-owner-only-file>'
const CODING_SESSION_HOST_USAGE = 'Usage: nessie-executor coding-session-host --config <absolute-owner-only-file> --session <uuid>'

const configPath = (args: readonly string[], usage: string): string => {
  const value = args[args.indexOf('--config') + 1]
  if (!args.includes('--config') || !value || !isAbsolute(value)) throw new Error(usage)
  return value
}

export const runBuiltinMcpCli = async (args: string[]): Promise<boolean> => {
  if (args[0] === 'serve-ollama-search-mcp') {
    if (args.length !== 1) throw new Error('Usage: nessie-executor serve-ollama-search-mcp')
    await serveOllamaSearchMcp()
    return true
  }
  if (args[0] === 'serve-coding-session-mcp') {
    if (args.length !== 3) throw new Error(CODING_SESSION_MCP_USAGE)
    await serveCodingSessionMcp(configPath(args, CODING_SESSION_MCP_USAGE))
    return true
  }
  if (args[0] === 'coding-session-host') {
    const session = args[args.indexOf('--session') + 1]
    if (args.length !== 5 || !args.includes('--session') || !session) throw new Error(CODING_SESSION_HOST_USAGE)
    await runCodingSessionHost({ configPath: configPath(args, CODING_SESSION_HOST_USAGE), sessionId: session })
    // A detached host has no parent waiting on it; leave as soon as the session is served.
    process.exit(0)
  }
  return false
}
