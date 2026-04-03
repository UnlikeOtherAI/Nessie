import { z } from 'zod'
import { buildTool } from './Tool.js'
import type { Tool } from './Tool.js'
import type { ToolUseContext } from './types.js'
import { glob as globAsync } from 'glob'

const GlobSchema = z.object({
  pattern: z.string(),
  cwd: z.string().optional(),
})

export type GlobInput = z.infer<typeof GlobSchema>

export function createGlobTool(): Tool<GlobInput, { files: string[] }> {
  return buildTool({
    name: 'Glob',
    description: 'Find files matching a glob pattern',
    inputSchema: GlobSchema,

    async call(args, _ctx) {
      const files = await globAsync(args.pattern, { cwd: args.cwd ?? process.cwd() })
      return { data: { files } }
    },

    isConcurrencySafe() { return true },
    isReadOnly() { return true },
    userFacingName: (input) => `Find ${input?.pattern ?? '*'}`,
    getActivityDescription: (input) => `Finding ${input?.pattern ?? '*'}`,
    maxResultSizeChars: 10_000,
  })
}

export const GlobTool = createGlobTool()
