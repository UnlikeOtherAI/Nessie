import { z } from 'zod'
import { buildTool } from './Tool.js'
import type { Tool } from './Tool.js'
import { readFile } from 'fs/promises'
import { isPathAllowed } from './path-validator.js'

const FileReadSchema = z.object({
  file_path: z.string(),
  limit: z.number().optional(),
  offset: z.number().optional(),
})

export type FileReadInput = z.infer<typeof FileReadSchema>

export function createFileReadTool(): Tool<FileReadInput, { content: string; file_path: string }> {
  return buildTool({
    name: 'FileRead',
    description: 'Read the contents of a file from the filesystem',
    inputSchema: FileReadSchema,

    async call(args, ctx) {
      // Check path permissions before reading.
      const allowed = isPathAllowed(args.file_path, ctx.options.agentPathPermissions)
      if (!allowed) {
        throw new Error(
          `Access denied: path '${args.file_path}' is not allowed by this agent's pathPermissions.`,
        )
      }
      const content = await readFile(args.file_path, 'utf-8')
      const offset = args.offset ?? 0
      const limit = args.limit
      const sliced = limit ? content.slice(offset, offset + limit) : content.slice(offset)
      return { data: { content: sliced, file_path: args.file_path } }
    },

    isConcurrencySafe() { return true },
    isReadOnly() { return true },
    userFacingName: (input) => `Read ${input?.file_path ?? 'file'}`,
    getActivityDescription: (input) => `Reading ${input?.file_path ?? 'file'}`,
    maxResultSizeChars: 50_000,
  })
}

export const FileReadTool = createFileReadTool()
