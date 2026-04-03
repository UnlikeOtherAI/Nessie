import { z } from 'zod'
import { buildTool } from './Tool.js'
import type { Tool } from './Tool.js'
import type { ToolUseContext } from './types.js'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

const BashToolSchema = z.object({
  command: z.string(),
  description: z.string().optional(),
  timeout: z.number().optional(),
})

export type BashToolInput = z.infer<typeof BashToolSchema>

export function createBashTool(): Tool<BashToolInput, { stdout: string; stderr: string; exitCode: number }> {
  return buildTool({
    name: 'Bash',
    description: 'Execute a shell command on the system',
    inputSchema: BashToolSchema,

    async call(args, _context) {
      const timeout = args.timeout ?? 30000
      try {
        const { stdout, stderr } = await execAsync(args.command, { timeout })
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
