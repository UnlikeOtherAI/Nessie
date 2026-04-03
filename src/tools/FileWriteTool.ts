import { z } from 'zod'
import { buildTool } from './Tool.js'
import type { Tool } from './Tool.js'
import type { ToolUseContext } from './types.js'
import { writeFile } from 'fs/promises'

const FileWriteSchema = z.object({
  file_path: z.string(),
  content: z.string(),
})

export type FileWriteInput = z.infer<typeof FileWriteSchema>

export function createFileWriteTool(): Tool<FileWriteInput, { success: boolean; file_path: string }> {
  return buildTool({
    name: 'FileWrite',
    description: 'Write content to a file on the filesystem',
    inputSchema: FileWriteSchema,

    async call(args, _ctx) {
      await writeFile(args.file_path, args.content, 'utf-8')
      return { data: { success: true, file_path: args.file_path } }
    },

    isConcurrencySafe() { return false },
    isReadOnly() { return false },
    userFacingName: (input) => `Write ${input?.file_path ?? 'file'}`,
    getActivityDescription: (input) => `Writing ${input?.file_path ?? 'file'}`,
    maxResultSizeChars: 1_000,
  })
}

export const FileWriteTool = createFileWriteTool()
