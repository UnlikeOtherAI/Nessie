import { z } from 'zod'
import { buildTool } from './Tool.js'
import type { Tool } from './Tool.js'
import { exec, spawn } from 'child_process'
import { promisify } from 'util'
import { which } from 'which'
import type { ExecProxyConfig } from '@nessie/config'

const execAsync = promisify(exec)

const BashToolSchema = z.object({
  command: z.string(),
  description: z.string().optional(),
  timeout: z.number().optional(),
})

export type BashToolInput = z.infer<typeof BashToolSchema>

/**
 * Tokenize a shell command string into safe arguments for spawn().
 * Handles quoted strings (single/double), escape sequences, and whitespace.
 * This prevents shell injection since we use spawn() with argv array.
 */
function tokenizeCommand(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let inSingleQuote = false
  let inDoubleQuote = false
  let i = 0

  while (i < command.length) {
    const ch = command[i]

    if (inSingleQuote) {
      if (ch === "'") {
        inSingleQuote = false
      } else {
        current += ch
      }
      i++
      continue
    }

    if (inDoubleQuote) {
      if (ch === '"') {
        inDoubleQuote = false
      } else if (ch === '\\' && i + 1 < command.length && command[i + 1] === '"') {
        current += '"'
        i += 2
      } else {
        current += ch
      }
      i++
      continue
    }

    if (ch === "'") {
      inSingleQuote = true
      i++
      continue
    }

    if (ch === '"') {
      inDoubleQuote = true
      i++
      continue
    }

    if (ch === '\\' && i + 1 < command.length) {
      const next = command[i + 1]
      if (next === '\\' || next === '"' || next === '$' || next === '`' || next === '\n') {
        current += next
        i += 2
        continue
      }
    }

    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
      i++
      continue
    }

    current += ch
    i++
  }

  if (current.length > 0) {
    tokens.push(current)
  }

  return tokens
}

/**
 * Check if a command matches an allowlisted executable using proper tokenization.
 */
function matchesAllowlist(commandTokens: string[], allowlist: string[]): boolean {
  if (commandTokens.length === 0 || allowlist.length === 0) {
    return false
  }

  // First token is the command executable
  const cmd = commandTokens[0].toLowerCase()

  // Exact match first, then prefix match
  return allowlist.some(allowed => {
    const a = allowed.toLowerCase()
    if (cmd === a) return true
    // Only allow actual path prefixes like /usr/bin/git
    if (cmd.startsWith(a + '/')) return true
    return false
  })
}

/**
 * Create a BashTool with optional RTK exec proxy support.
 *
 * RTK (Rust Token Killer) compresses CLI output to save context tokens (50-87% reduction).
 * Commands matching the allowlist are wrapped with `rtk` binary for output compression.
 *
 * @param execProxyConfig - Typed exec proxy config from NessieConfig.agent.execProxy
 */
export function createBashTool(execProxyConfig?: ExecProxyConfig): Tool<BashToolInput, { stdout: string; stderr: string; exitCode: number }> {
  return buildTool({
    name: 'Bash',
    description: 'Execute a shell command on the system',
    inputSchema: BashToolSchema,

    async call(args, _context) {
      const timeout = args.timeout ?? 30000
      const command = args.command
      const config = execProxyConfig ?? { enabled: false, binary: 'rtk', commands: [] }

      let useRtk = false

      // Apply RTK exec proxy if configured and command is allowlisted
      if (config.enabled && config.commands.length > 0) {
        const tokens = tokenizeCommand(command)
        if (matchesAllowlist(tokens, config.commands)) {
          // Resolve rtk binary from PATH
          const rtkPath = await which(config.binary).catch(() => null)
          if (rtkPath) {
            useRtk = true
          } else {
            console.warn(`[BashTool] RTK exec proxy enabled but binary not found in PATH: ${config.binary}`)
          }
        }
      }

      if (useRtk) {
        // Use spawn with argv array to avoid shell injection
        return new Promise((resolve) => {
          const rtkPath = which.sync(config.binary)
          const tokens = tokenizeCommand(command)
          const child = spawn(rtkPath, ['exec', '--', ...tokens], {
            timeout,
            env: process.env,
          })

          let stdout = ''
          let stderr = ''

          child.stdout.on('data', (data) => { stdout += data.toString() })
          child.stderr.on('data', (data) => { stderr += data.toString() })

          child.on('close', (code) => {
            resolve({ data: { stdout, stderr, exitCode: code ?? 1 } })
          })

          child.on('error', () => {
            resolve({ data: { stdout, stderr, exitCode: 1 } })
          })
        })
      }

      // Standard execution using spawn with argv array (no shell)
      const tokens = tokenizeCommand(command)
      if (tokens.length === 0) {
        return { data: { stdout: '', stderr: 'Empty command', exitCode: 1 } }
      }

      return new Promise((resolve) => {
        const [cmd, ...args_] = tokens
        const child = spawn(cmd, args_, {
          timeout,
          env: process.env,
        })

        let stdout = ''
        let stderr = ''

        child.stdout?.on('data', (data) => { stdout += data.toString() })
        child.stderr?.on('data', (data) => { stderr += data.toString() })

        child.on('close', (code) => {
          resolve({ data: { stdout, stderr, exitCode: code ?? 1 } })
        })

        child.on('error', () => {
          resolve({ data: { stdout, stderr, exitCode: 1 } })
        })
      })
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
