import type { PrismaClient } from '@prisma/client'
import {
  runAttachmentListTool,
  runAttachmentReadTool,
  runAttachmentUploadTool,
  runAuthoredMessageSearchTool,
  runChannelArchiveTool,
  runChannelFindTool,
  runChannelJoinTool,
  runChannelListTool,
  runChannelUpdateTool,
  runKbCommentAddTool,
  runKbCommentReplyTool,
  runKbCommentResolveTool,
  runKbCommentsListTool,
  runKbListTool,
  runKbNoteAddTool,
  runKbPageReadTool,
  runKbSearchTool,
  runMessageDeleteTool,
  runMessageEditTool,
  runMessageSearchTool,
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
import { summarizeToolInput, truncateToolResult } from './tool-util.js'
import type { BuiltinToolRuntimeContext, ToolExecutionUsage } from './tool-types.js'

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
  connectorUsage?: ToolExecutionUsage
  inputSummary: string
  output: string
  success: boolean
}

const wrapTool = async (
  inputSummary: string,
  fn: () => Promise<{ connectorUsage?: ToolExecutionUsage; outputPreview: string }>,
): Promise<AgenticToolResult> => {
  try {
    const result = await fn()
    return {
      connectorUsage: result.connectorUsage,
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
  const inputSummary = summarizeToolInput(args)
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
    // sp-channels: channel lifecycle tools
    case 'channel_find':
      return wrapTool(inputSummary, () =>
        runChannelFindTool(context, {
          query: String(args.query ?? ''),
          limit: args.limit,
        }),
      )
    case 'channel_list':
      return wrapTool(inputSummary, () =>
        runChannelListTool(context, {
          includeArchived:
            typeof args.includeArchived === 'boolean' ? args.includeArchived : undefined,
          limit: args.limit,
        }),
      )
    case 'channel_update':
      return wrapTool(inputSummary, () =>
        runChannelUpdateTool(context, {
          channelId: String(args.channelId ?? ''),
          label: typeof args.label === 'string' ? args.label : undefined,
          topic: typeof args.topic === 'string' ? args.topic : undefined,
          description:
            typeof args.description === 'string' ? args.description : undefined,
        }),
      )
    case 'channel_archive':
      return wrapTool(inputSummary, () =>
        runChannelArchiveTool(context, {
          channelId: String(args.channelId ?? ''),
          archived: typeof args.archived === 'boolean' ? args.archived : undefined,
        }),
      )
    case 'channel_join':
      return wrapTool(inputSummary, () =>
        runChannelJoinTool(context, {
          channelId: String(args.channelId ?? ''),
        }),
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
    case 'message_search':
      return wrapTool(inputSummary, () =>
        runMessageSearchTool(context, {
          channelId:
            typeof args.channelId === 'string' ? args.channelId : undefined,
          limit: args.limit,
          query: String(args.query ?? ''),
        }),
      )
    case 'message_edit':
      return wrapTool(inputSummary, () =>
        runMessageEditTool(context, {
          content: String(args.content ?? ''),
          messageId: String(args.messageId ?? ''),
        }),
      )
    case 'message_delete':
      return wrapTool(inputSummary, () =>
        runMessageDeleteTool(context, {
          messageId: String(args.messageId ?? ''),
        }),
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
    case 'kb_comments_list':
      return wrapTool(inputSummary, () =>
        runKbCommentsListTool(context, {
          pageId: String(args.pageId ?? ''),
          kind:
            args.kind === 'comment' || args.kind === 'note' ? args.kind : undefined,
        }),
      )
    case 'kb_comment_add':
      return wrapTool(inputSummary, () =>
        runKbCommentAddTool(context, {
          pageId: String(args.pageId ?? ''),
          body: String(args.body ?? ''),
        }),
      )
    case 'kb_comment_reply':
      return wrapTool(inputSummary, () =>
        runKbCommentReplyTool(context, {
          annotationId: String(args.annotationId ?? ''),
          body: String(args.body ?? ''),
        }),
      )
    case 'kb_comment_resolve':
      return wrapTool(inputSummary, () =>
        runKbCommentResolveTool(context, {
          annotationId: String(args.annotationId ?? ''),
          state: args.state === 'open' ? 'open' : 'resolved',
        }),
      )
    case 'kb_note_add':
      return wrapTool(inputSummary, () =>
        runKbNoteAddTool(context, {
          pageId: String(args.pageId ?? ''),
          quote: String(args.quote ?? ''),
          body: String(args.body ?? ''),
        }),
      )
    case 'kb_search':
      return wrapTool(inputSummary, () =>
        runKbSearchTool(context, {
          query: String(args.query ?? ''),
          spaceId: typeof args.spaceId === 'string' ? args.spaceId : undefined,
          projectId: typeof args.projectId === 'string' ? args.projectId : undefined,
          limit: args.limit,
        }),
      )
    case 'kb_page_read':
      return wrapTool(inputSummary, () =>
        runKbPageReadTool(context, { pageId: String(args.pageId ?? '') }),
      )
    case 'kb_list':
      return wrapTool(inputSummary, () =>
        runKbListTool(context, {
          spaceId: typeof args.spaceId === 'string' ? args.spaceId : undefined,
        }),
      )
    default:
      return { inputSummary, output: 'Unknown tool: ' + toolName, success: false }
  }
}
