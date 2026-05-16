import { open } from 'node:fs/promises'
import { z } from 'zod'

import { assertInsideSandbox, extractSandboxConfig } from './sandbox.js'

const DEFAULT_MAX_BYTES = 1 * 1024 * 1024

const InputSchema = z.object({
  path: z.string().min(1),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
  maxBytes: z.number().int().positive().optional(),
})

export type FileReadInput = z.infer<typeof InputSchema>

export type FileReadOutput = {
  path: string
  encoding: 'utf8' | 'base64'
  content: string
  bytesRead: number
  truncated: boolean
}

const TOOL_ID = 'file_read'

export const runFileRead = async (
  rawArgs: unknown,
  transportConfig: unknown,
): Promise<FileReadOutput> => {
  const input = InputSchema.parse(rawArgs)
  const sandbox = await extractSandboxConfig(transportConfig, TOOL_ID)
  const resolvedPath = await assertInsideSandbox(input.path, sandbox, TOOL_ID)
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES

  const handle = await open(resolvedPath, 'r')
  try {
    const stat = await handle.stat()
    const fileSize = Number(stat.size)
    const bytesToRead = Math.min(fileSize, maxBytes)
    const buffer = Buffer.alloc(bytesToRead)
    let totalRead = 0
    while (totalRead < bytesToRead) {
      const result = await handle.read(
        buffer,
        totalRead,
        bytesToRead - totalRead,
        totalRead,
      )
      if (result.bytesRead === 0) {
        break
      }
      totalRead += result.bytesRead
    }

    const slice = buffer.subarray(0, totalRead)
    return {
      path: resolvedPath,
      encoding: input.encoding,
      content:
        input.encoding === 'base64' ? slice.toString('base64') : slice.toString('utf8'),
      bytesRead: totalRead,
      truncated: fileSize > totalRead,
    }
  } finally {
    await handle.close()
  }
}
