import { z } from 'zod'
import { buildTool } from './Tool.js'
import type { Tool } from './Tool.js'
import type { ToolUseContext } from './types.js'

const GrepSchema = z.object({
  pattern: z.string(),
  path: z.string().optional(),
})

export type GrepInput = z.infer<typeof GrepSchema>

export function createGrepTool(): Tool<GrepInput, { matches: string[] }> {
  return buildTool({
    name: 'Grep',
    description: 'Search for a pattern in files using grep',
    inputSchema: GrepSchema,

    async call(args, _ctx) {
      const { exec } = await import('child_process')
      const { promisify } = await import('util')
      const execAsync = promisify(exec)
      const cmd = `grep -r "${args.pattern}" ${args.path ?? '.'} 2>/dev/null | head -50`
      try {
        const { stdout } = await execAsync(cmd, { timeout: 10000 })
        const matches = stdout.split('\n').filter(Boolean)
        return { data: { matches } }
      } catch {
        return { data: { matches: [] } }
      }
    },

    isConcurrencySafe() { return true },
    isReadOnly() { return true },
    userFacingName: (input) => `Grep: ${input?.pattern ?? ''}`,
    getActivityDescription: (input) => `Searching for: ${input?.pattern ?? ''}`,
    maxResultSizeChars: 10_000,
  })
}

export const GrepTool = createGrepTool()
