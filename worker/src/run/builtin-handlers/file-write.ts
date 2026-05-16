import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'

import { assertInsideSandbox, extractSandboxConfig } from './sandbox.js'

const InputSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
  overwrite: z.boolean().default(false),
  createParents: z.boolean().default(false),
})

export type FileWriteInput = z.infer<typeof InputSchema>

export type FileWriteOutput = {
  path: string
  bytesWritten: number
  created: boolean
}

const TOOL_ID = 'file_write'

export class FileWriteOverwriteError extends Error {
  override readonly name = 'FileWriteOverwriteError'

  constructor(message: string) {
    super(message)
  }
}

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await stat(target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }
}

export const runFileWrite = async (
  rawArgs: unknown,
  transportConfig: unknown,
): Promise<FileWriteOutput> => {
  const input = InputSchema.parse(rawArgs)
  const sandbox = await extractSandboxConfig(transportConfig, TOOL_ID)
  const resolvedPath = await assertInsideSandbox(input.path, sandbox, TOOL_ID)

  const existed = await pathExists(resolvedPath)
  if (existed && !input.overwrite) {
    throw new FileWriteOverwriteError(
      `Refusing to overwrite existing file at "${resolvedPath}" without overwrite=true.`,
    )
  }

  if (input.createParents) {
    const parent = dirname(resolvedPath)
    await assertInsideSandbox(parent, sandbox, TOOL_ID)
    await mkdir(parent, { recursive: true })
  }

  const buffer =
    input.encoding === 'base64'
      ? Buffer.from(input.content, 'base64')
      : Buffer.from(input.content, 'utf8')

  await writeFile(resolvedPath, buffer)

  return {
    path: resolvedPath,
    bytesWritten: buffer.byteLength,
    created: !existed,
  }
}
