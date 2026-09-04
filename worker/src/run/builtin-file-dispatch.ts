import type { PrismaClient } from '@prisma/client'
import {
  FileWriteOverwriteError,
  HttpFetchError,
  runFileGlob,
  runFileRead,
  runFileWrite,
  runHttpFetch,
  SandboxViolationError,
} from './builtin-handlers/index.js'
import type { AgenticToolResult, BuiltinToolRuntimeContext } from './tool-types.js'
import { truncateToolResult } from './tool-util.js'

const BUILTIN_REGISTRY_SCOPE_KEY = 'builtin'

const loadBuiltinTransportConfig = async (
  prisma: PrismaClient,
  organizationId: string,
  toolId: string,
): Promise<unknown> => {
  const entry = await prisma.toolRegistryEntry.findUnique({
    where: {
      organizationId_scopeKey_toolId: {
        organizationId,
        scopeKey: BUILTIN_REGISTRY_SCOPE_KEY,
        toolId,
      },
    },
    select: { transportConfig: true },
  })
  return entry?.transportConfig ?? {}
}

const wrapBuiltinResult = (
  inputSummary: string,
  fn: () => Promise<unknown>,
): Promise<AgenticToolResult> =>
  fn().then(
    (output) => ({
      inputSummary,
      output: truncateToolResult(JSON.stringify(output, null, 2)),
      success: true,
    }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      if (
        error instanceof SandboxViolationError
        || error instanceof FileWriteOverwriteError
        || error instanceof HttpFetchError
      ) {
        return { inputSummary, output: `${error.name}: ${message}`, success: false }
      }
      return { inputSummary, output: `Tool error: ${message}`, success: false }
    },
  )

/** Dispatch the sandboxed filesystem and HTTP builtins. */
export const executeBuiltinFileTool = async (
  toolName: string,
  args: Record<string, unknown>,
  context: BuiltinToolRuntimeContext,
  inputSummary: string,
): Promise<AgenticToolResult | null> => {
  switch (toolName) {
    case 'http_fetch':
      return wrapBuiltinResult(inputSummary, () => runHttpFetch(args))
    case 'file_read':
    case 'file_write':
    case 'file_glob': {
      const transportConfig = await loadBuiltinTransportConfig(
        context.prisma,
        context.channel.organizationId,
        toolName,
      )
      const fn = toolName === 'file_read'
        ? runFileRead
        : toolName === 'file_write'
          ? runFileWrite
          : runFileGlob
      return wrapBuiltinResult(inputSummary, () => fn(args, transportConfig))
    }
    default:
      return null
  }
}
