import type { PrismaClient } from '@prisma/client'
import {
  runAttachmentListTool,
  runAttachmentReadTool,
  runAttachmentUploadTool,
  runAuthoredMessageSearchTool,
  runPeopleSearchTool,
  runSendMessageTool,
  runUpdatePreferencesTool,
  runWorkspaceSearchTool,
} from './pa-tools.js'
import {
  runCancelScheduledTaskTool,
  runListScheduledTasksTool,
  runScheduleTaskTool,
} from './schedule-tools.js'
import {
  FileWriteOverwriteError,
  HttpFetchError,
  runFileGlob,
  runFileRead,
  runFileWrite,
  runHttpFetch,
  SandboxViolationError,
} from './builtin-handlers/index.js'
import {
  coercePage,
  runDocumentReadTool,
  runWebFetchTool,
  runWebSearchTool,
} from './content-tools.js'
import { runSpawnSubtaskTool } from './subtask-tools.js'
import { truncateToolResult } from './tool-util.js'
import type { BuiltinToolRuntimeContext } from './tool-types.js'

// Re-exported so existing importers keep using the './tools.js' entry point.
export {
  runDocumentReadTool,
  runWebFetchTool,
  runWebSearchTool,
  shouldUseDocumentRead,
  shouldUseWebFetch,
  shouldUseWebSearch,
} from './content-tools.js'
export {
  executeWorkflowBuiltinTool,
  type WorkflowBuiltinToolRuntimeContext,
} from './workflow-builtin-tools.js'

export type AgenticToolResult = {
  inputSummary: string
  output: string
  success: boolean
}

const wrapTool = async (
  inputSummary: string,
  fn: () => Promise<{ outputPreview: string }>,
): Promise<AgenticToolResult> => {
  try {
    const result = await fn()
    return {
      inputSummary,
      output: truncateToolResult(result.outputPreview),
      success: true,
    }
  } catch (error) {
    return {
      inputSummary,
      output: 'Tool error: ' + (error instanceof Error ? error.message : String(error)),
      success: false,
    }
  }
}

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
        error instanceof SandboxViolationError ||
        error instanceof FileWriteOverwriteError ||
        error instanceof HttpFetchError
      ) {
        return {
          inputSummary,
          output: `${error.name}: ${message}`,
          success: false,
        }
      }
      return {
        inputSummary,
        output: 'Tool error: ' + message,
        success: false,
      }
    },
  )

export const executeBuiltinTool = async (
  toolName: string,
  args: Record<string, unknown>,
  context: BuiltinToolRuntimeContext,
): Promise<AgenticToolResult> => {
  const inputSummary = JSON.stringify(args).slice(0, 200)
  switch (toolName) {
    case 'workspace_search':
      return wrapTool(inputSummary, () =>
        runWorkspaceSearchTool(context, String(args.query ?? ''), args.limit),
      )
    case 'authored_message_search':
      return wrapTool(inputSummary, () =>
        runAuthoredMessageSearchTool(context, String(args.query ?? ''), args.limit),
      )
    case 'people_search':
      return wrapTool(inputSummary, () =>
        runPeopleSearchTool(context, String(args.query ?? ''), args.limit),
      )
    case 'send_message':
      return wrapTool(inputSummary, () =>
        runSendMessageTool(context, {
          channelId:
            typeof args.channelId === 'string' ? args.channelId : undefined,
          content: String(args.content ?? ''),
          targetUserId:
            typeof args.targetUserId === 'string' ? args.targetUserId : undefined,
          threadId:
            typeof args.threadId === 'string' ? args.threadId : undefined,
        }),
      )
    case 'update_preferences':
      return wrapTool(inputSummary, () =>
        runUpdatePreferencesTool(
          context,
          (typeof args.preferences === 'object' && args.preferences !== null
            ? args.preferences
            : null) as Record<string, unknown> | null,
        ),
      )
    case 'web_search':
      return wrapTool(inputSummary, () =>
        runWebSearchTool(String(args.query ?? ''), coercePage(args.page)),
      )
    case 'web_fetch':
      return wrapTool(inputSummary, () => runWebFetchTool(String(args.url ?? '')))
    case 'schedule_task':
      return wrapTool(inputSummary, () =>
        runScheduleTaskTool(context, {
          instructions: args.instructions,
          name: args.name,
          schedule: args.schedule,
          target: args.target,
        }),
      )
    case 'list_scheduled_tasks':
      return wrapTool(inputSummary, () => runListScheduledTasksTool(context))
    case 'cancel_scheduled_task':
      return wrapTool(inputSummary, () =>
        runCancelScheduledTaskTool(context, { id: args.id, name: args.name }),
      )
    case 'attachment_upload':
      return wrapTool(inputSummary, () =>
        runAttachmentUploadTool(context, {
          contentBase64:
            typeof args.contentBase64 === 'string' ? args.contentBase64 : undefined,
          filename: typeof args.filename === 'string' ? args.filename : undefined,
          mime: typeof args.mime === 'string' ? args.mime : undefined,
        }),
      )
    case 'attachment_list':
      return wrapTool(inputSummary, () =>
        runAttachmentListTool(context, {
          channelId: typeof args.channelId === 'string' ? args.channelId : undefined,
          limit: args.limit,
          threadId: typeof args.threadId === 'string' ? args.threadId : undefined,
        }),
      )
    case 'attachment_read':
      return wrapTool(inputSummary, () =>
        runAttachmentReadTool(context, {
          id: typeof args.id === 'string' ? args.id : undefined,
        }),
      )
    case 'document_read':
      return wrapTool(inputSummary, () => runDocumentReadTool(String(args.query ?? '')))
    case 'spawn_subtask':
      return wrapTool(inputSummary, () =>
        runSpawnSubtaskTool(context, {
          role: args.role,
          task: args.task,
        }),
      )
    case 'http_fetch':
      return wrapBuiltinResult(inputSummary, () => runHttpFetch(args))
    case 'file_read':
      return wrapBuiltinResult(inputSummary, async () => {
        const transportConfig = await loadBuiltinTransportConfig(
          context.prisma,
          context.channel.organizationId,
          'file_read',
        )
        return runFileRead(args, transportConfig)
      })
    case 'file_write':
      return wrapBuiltinResult(inputSummary, async () => {
        const transportConfig = await loadBuiltinTransportConfig(
          context.prisma,
          context.channel.organizationId,
          'file_write',
        )
        return runFileWrite(args, transportConfig)
      })
    case 'file_glob':
      return wrapBuiltinResult(inputSummary, async () => {
        const transportConfig = await loadBuiltinTransportConfig(
          context.prisma,
          context.channel.organizationId,
          'file_glob',
        )
        return runFileGlob(args, transportConfig)
      })
    default:
      return { inputSummary, output: 'Unknown tool: ' + toolName, success: false }
  }
}
