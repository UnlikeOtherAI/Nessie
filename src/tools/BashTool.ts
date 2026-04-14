import { z } from 'zod'
import { buildTool } from './Tool.js'
import type { Tool } from './Tool.js'
import { exec } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'node:fs'

const execAsync = promisify(exec)

const BashToolSchema = z.object({
  command: z.string(),
  description: z.string().optional(),
  timeout: z.number().optional(),
})

export type BashToolInput = z.infer<typeof BashToolSchema>

/**
 * RTK exec proxy configuration loaded from environment variables.
 * When enabled, matching commands are wrapped with `rtk` to compress output.
 *
 * Environment variables:
 * - NESSIE_AGENT_EXEC_PROXY_ENABLED=true|false (default: false)
 * - NESSIE_AGENT_EXEC_PROXY_BINARY=/path/to/rtk (default: rtk)
 * - NESSIE_AGENT_EXEC_PROXY_COMMANDS=git,npm,pnpm (comma-separated list)
 */

interface RtkConfig {
  enabled: boolean
  binary: string
  commands: string[]
}

function getRtkConfig(): RtkConfig {
  const enabled = process.env.NESSIE_AGENT_EXEC_PROXY_ENABLED === 'true'
  const binary = process.env.NESSIE_AGENT_EXEC_PROXY_BINARY ?? 'rtk'
  const commandsStr = process.env.NESSIE_AGENT_EXEC_PROXY_COMMANDS ?? ''
  const commands = commandsStr
    ? commandsStr.split(',').map(s => s.trim()).filter(s => s.length > 0)
    : []

  return { enabled, binary, commands }
}

/**
 * Check if a command should be proxied through RTK based on the execProxy config.
 * Returns true if:
 * - execProxy.enabled is true
 * - the command starts with one of the configured allowlisted commands
 * - the rtk binary exists on the system
 */
function shouldUseRtkProxy(command: string): boolean {
  const config = getRtkConfig()

  if (!config.enabled) {
    return false
  }

  if (!config.commands || config.commands.length === 0) {
    return false
  }

  // Check if command starts with any allowlisted command
  const isAllowlisted = config.commands.some((allowed) => {
    const trimmed = allowed.trim()
    return trimmed.length > 0 && command.trim().startsWith(trimmed)
  })

  if (!isAllowlisted) {
    return false
  }

  // Check if rtk binary exists
  if (!existsSync(config.binary)) {
    console.warn(`[BashTool] RTK exec proxy enabled but binary not found: ${config.binary}`)
    return false
  }

  return true
}

/**
 * Wrap a command with RTK proxy if eligible.
 * RTK (Rust Token Killer) compresses CLI output to save context tokens (50-87% reduction).
 */
function wrapWithRtkProxy(command: string): string {
  const config = getRtkConfig()
  return `${config.binary} ${command}`
}

export function createBashTool(): Tool<BashToolInput, { stdout: string; stderr: string; exitCode: number }> {
  return buildTool({
    name: 'Bash',
    description: 'Execute a shell command on the system',
    inputSchema: BashToolSchema,

    async call(args, _context) {
      const timeout = args.timeout ?? 30000
      let command = args.command

      // Apply RTK exec proxy if configured and command is allowlisted
      if (shouldUseRtkProxy(command)) {
        command = wrapWithRtkProxy(command)
        console.debug(`[BashTool] Using RTK proxy: ${command}`)
      }

      try {
        const { stdout, stderr } = await execAsync(command, { timeout })
        return { data: { stdout, stderr, exitCode: 0 } }
      } catch (err: unknown) {
        const error = err as { stdout?: string; stderr?: string; code?: number }
        return {
          data: {
            stdout: error.stdout ?? '',
            stderr: error.stderr ?? String(err),
            exitCode: error.code ?? 1,
          },
        }
      }
    },

    isConcurrencySafe() { return false },
    isReadOnly() { return false },

    userFacingName() { return 'Bash' },
    getActivityDescription(input) {
      return input?.description ?? `Running: ${String(input?.command ?? 'command').split(' ')[0]}`
    },
    maxResultSizeChars: 10_000,
  })
}

export const BashTool = createBashTool()
