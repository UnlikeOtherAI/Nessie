import type { PrismaClient } from '@prisma/client'
import {
  FILESYSTEM_BUILTIN_TOOLS,
  loadConfig,
  localOnlyCapabilityMessage,
} from '@nessie/config'
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

/**
 * `file_read`/`file_write`/`file_glob` do raw `node:fs` I/O on this worker's
 * own disk under the `allowedRoots` an operator put on the tool's registry
 * entry (audit 6.2). Outside `local` mode that disk is not the disk the next
 * run lands on, so the three are refused here — the single dispatch chokepoint
 * for exactly these tools. It cannot be `loadConfig`: `allowedRoots` is a
 * column on `tool_registry_entries`, per-organisation data that configuration
 * never sees. See docs/standards/horizontal-scaling.md, invariant 7.
 *
 * The refusal is a failed tool result, not a thrown error: the model asked for
 * the tool, and the answer it needs is the sentence saying why the tool does
 * not exist on this deployment and what to use instead.
 */
const filesystemBuiltinRefusal = (): string | null => {
  const { mode } = loadConfig()
  return mode === 'local'
    ? null
    : localOnlyCapabilityMessage(mode, FILESYSTEM_BUILTIN_TOOLS)
}

const loadTransportConfig = async (
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

const wrapSandboxedResult = (
  inputSummary: string,
  fn: () => Promise<unknown>,
): Promise<AgenticToolResult> => fn().then(
  (output) => ({
    inputSummary,
    output: truncateToolResult(JSON.stringify(output, null, 2)),
    success: true,
  }),
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    if (
      error instanceof SandboxViolationError ||
      error instanceof FileWriteOverwriteError ||
      error instanceof HttpFetchError
    ) {
      return { inputSummary, output: `${error.name}: ${message}`, success: false }
    }
    return { inputSummary, output: 'Tool error: ' + message, success: false }
  },
)

export const dispatchSandboxedBuiltinTool = (
  toolName: string,
  args: Record<string, unknown>,
  context: BuiltinToolRuntimeContext,
  inputSummary: string,
): Promise<AgenticToolResult | null> => {
  switch (toolName) {
    case 'http_fetch':
      return wrapSandboxedResult(inputSummary, () => runHttpFetch(args))
    case 'file_read':
    case 'file_write':
    case 'file_glob': {
      const refusal = filesystemBuiltinRefusal()
      if (refusal !== null) {
        return Promise.resolve({ inputSummary, output: refusal, success: false })
      }
      return loadTransportConfig(
        context.prisma,
        context.channel.organizationId,
        toolName,
      ).then((transportConfig) => {
        const runner = toolName === 'file_read'
          ? runFileRead
          : toolName === 'file_write'
            ? runFileWrite
            : runFileGlob
        return wrapSandboxedResult(inputSummary, () => runner(args, transportConfig))
      })
    }
    default:
      return Promise.resolve(null)
  }
}
