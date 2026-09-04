import { BUILTIN_TOOL_DEFINITIONS } from '@nessie/runtime'
import type { PrismaClient } from '@prisma/client'
import { appendStubbedBuiltinSchema } from './builtin-toolset-deferred.js'
import { resolveDashboardToolServices } from './pa-tools/dashboard-context.js'
import { runDashboardTool } from './pa-tools/dashboards.js'
import {
  runGmailSearchTool,
  runGmailThreadReadTool,
  runGmailMessageReadTool,
  runGmailDraftCreateTool,
  runGmailDraftUpdateTool,
} from './pa-tools/gmail-tools.js'
import { runGmailDraftSendTool } from './pa-tools/gmail-send-tool.js'
import {
  runMailboxReadTool,
  runMailboxSearchTool,
  runMailboxSendTool,
} from './pa-tools/mailbox-tools.js'
import {
  runGmailLabelsListTool,
  runGmailOrganiseTool,
  runGmailAttachmentReadTool,
  runContactsSearchTool,
  runCalendarEventRespondTool,
} from './pa-tools/gmail-organise-tools.js'
import {
  runCalendarListTool,
  runCalendarEventsListTool,
  runCalendarFreeBusyTool,
  runCalendarEventCreateTool,
  runCalendarEventUpdateTool,
  runCalendarEventCancelTool,
} from './pa-tools/calendar-tools.js'
import {
  runAppConnectRequestTool,
  runAppSearchTool,
  runCardPostTool,
  runAttachmentListTool,
  runAttachmentReadTool,
  runAttachmentUploadTool,
  runAgentAvatarUpdateTool,
  runAgentBindChannelTool,
  runAgentCreateTool,
  runAgentListTool,
  runAgentReadTool,
  runAgentToolCatalogTool,
  runAgentTriggerCreateTool,
  runAgentUpdateTool,
  runAuthoredMessageSearchTool,
  runCallStartTool,
  runChannelArchiveTool,
  runChannelCreateTool,
  runChannelFindTool,
  runChannelJoinTool,
  runChannelListTool,
  runChannelUpdateTool,
  runCommsConnectCardTool,
  runDeepWaterRunUpdateTool,
  runDemonstrationStartTool,
  runDemonstrationStopTool,
  runMessageDeleteTool,
  runReactTool,
  runMessageEditTool,
  runMessageSearchTool,
  runMeetingLinkCreateTool,
  runPeopleSearchTool,
  runPersonalAssistantJoinChannelTool,
  runProjectCreateTool,
  runProjectListTool,
  runSendMessageTool,
  runTeamCreateTool,
  runUpdatePreferencesTool,
  runTodoStartTool,
  runTodoStepUpdateTool,
  runTodoTemplateProposeTool,
  runWorkflowTransformPreviewTool,
  runTeamSearchTool,
  runEmailListTool,
  runEmailReadTool,
  runEmailSendTool,
} from './pa-tools.js'
import { runAgentHandoffTool } from './pa-tools/agent-handoff.js'
import { cloudBrowserTool } from './browser-cloud/browser-tools.js'
import { connectorManagementTool } from './pa-tools/connector-dispatch.js'
import { executorManagementTool } from './pa-tools/executor-dispatch.js'
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
import { summarizeToolInput, truncateToolResult, wrapTool } from './tool-util.js'
import { dispatchKbTool } from './kb-tool-dispatch.js'
import type { AgenticToolResult, BuiltinToolRuntimeContext } from './tool-types.js'

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

export type { AgenticToolResult } from './tool-types.js'

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

const executeBuiltinToolUncorrected = async (
  toolName: string,
  args: Record<string, unknown>,
  context: BuiltinToolRuntimeContext,
): Promise<AgenticToolResult> => {
  const inputSummary = summarizeToolInput(args)
  const executorTool = executorManagementTool(toolName, args, context)
  if (executorTool) return wrapTool(inputSummary, executorTool)
  const connectorTool = connectorManagementTool(toolName, args, context)
  if (connectorTool) return wrapTool(inputSummary, connectorTool)
  const browserResult = cloudBrowserTool(toolName, args, context)
  if (browserResult) return browserResult
  const knowledgeBaseResult = dispatchKbTool(toolName, args, context, inputSummary)
  if (knowledgeBaseResult) return knowledgeBaseResult
  switch (toolName) {
    case 'card_post':
      return wrapTool(inputSummary, () => runCardPostTool(context, args))
    case 'app_search':
      return wrapTool(inputSummary, () => runAppSearchTool(context, args))
    case 'app_connect_request':
      return wrapTool(inputSummary, () => runAppConnectRequestTool(context, args))
    case 'team_search':
      return wrapTool(inputSummary, () =>
        runTeamSearchTool(context, String(args.query ?? ''), args.limit),
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
          attachmentIds: args.attachmentIds,
          channelId:
            typeof args.channelId === 'string' ? args.channelId : undefined,
          content: String(args.content ?? ''),
          targetUserId:
            typeof args.targetUserId === 'string' ? args.targetUserId : undefined,
          threadId:
            typeof args.threadId === 'string' ? args.threadId : undefined,
        }),
      )
    case 'workflow_transform_preview':
      return wrapTool(inputSummary, () =>
        runWorkflowTransformPreviewTool(
          context,
          String(args.expression ?? ''),
          args.sampleJson,
        ),
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
    // Team provisioning. These validate their own arguments with zod
    // (the same create-trigger body the route parses), so they take `args` whole.
    case 'channel_create':
      return wrapTool(inputSummary, () => runChannelCreateTool(context, args))
    case 'agent_create':
      return wrapTool(inputSummary, () => runAgentCreateTool(context, args))
    // Team structure: the project and team a channel lives inside, plus
    // the read that turns a project or team NAME into the id they take.
    case 'project_list':
      return wrapTool(inputSummary, () => runProjectListTool(context, args))
    case 'project_create':
      return wrapTool(inputSummary, () => runProjectCreateTool(context, args))
    case 'team_create':
      return wrapTool(inputSummary, () => runTeamCreateTool(context, args))
    case 'agent_list':
      return wrapTool(inputSummary, () => runAgentListTool(context, args))
    // Agent configuration: read one agent's record, rewrite it, list the tools
    // this team can actually give it, set its portrait. Authority lives in
    // the shared `canEditAgent` predicate the PUT route uses.
    case 'agent_read':
      return wrapTool(inputSummary, () => runAgentReadTool(context, args))
    case 'agent_update':
      return wrapTool(inputSummary, () => runAgentUpdateTool(context, args))
    case 'agent_tool_catalog':
      return wrapTool(inputSummary, () => runAgentToolCatalogTool(context, args))
    case 'agent_avatar_update':
      return wrapTool(inputSummary, () => runAgentAvatarUpdateTool(context, args))
    case 'agent_bind_channel':
      return wrapTool(inputSummary, () => runAgentBindChannelTool(context, args))
    case 'agent_trigger_create':
      return wrapTool(inputSummary, () => runAgentTriggerCreateTool(context, args))
    // Available to every agent by default; its loop bounds are structural (a
    // global agent and a subtask child never see it — see tool-policy.ts).
    case 'agent_handoff':
      return wrapTool(inputSummary, () => runAgentHandoffTool(context, args))
    // To-do execution. Arguments are validated in the shared-operation callers
    // so context-derived agent/run ids can never be supplied by the model.
    case 'todo_start':
      return wrapTool(inputSummary, () => runTodoStartTool(context, args))
    case 'todo_step_update':
      return wrapTool(inputSummary, () => runTodoStepUpdateTool(context, args))
    case 'todo_template_propose':
      return wrapTool(inputSummary, () => runTodoTemplateProposeTool(context, args))
    case 'demonstration_start':
      return wrapTool(inputSummary, () => runDemonstrationStartTool(context, args))
    case 'demonstration_stop':
      return wrapTool(inputSummary, () => runDemonstrationStopTool(context, args))
    case 'pa_join_channel':
      return wrapTool(inputSummary, () => runPersonalAssistantJoinChannelTool(context, args))
    // Dashboards. Grantable to any agent (not PA-only), so the gate is the
    // agent's tool policy; each call runs the same service function the REST
    // route runs and inherits its authorization.
    case 'dashboard_list':
    case 'dashboard_create':
    case 'dashboard_source_list':
    case 'dashboard_source_probe':
    case 'dashboard_source_create':
    case 'dashboard_source_set_credential':
    case 'dashboard_widget_add':
    case 'dashboard_widget_update':
    case 'dashboard_widget_move':
    case 'dashboard_widget_remove':
    case 'dashboard_read':
    case 'dashboard_widget_post':
      return wrapTool(inputSummary, async () => {
        const services = await resolveDashboardToolServices(context.prisma)
        return runDashboardTool(toolName, context, args, services)
      })
    case 'web_search':
      return wrapTool(inputSummary, () =>
        runWebSearchTool(context, String(args.query ?? ''), coercePage(args.page)),
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
    case 'react':
      return wrapTool(inputSummary, () =>
        runReactTool(context, {
          emoji: String(args.emoji ?? ''),
          messageId: String(args.messageId ?? ''),
          ...(args.remove === true ? { remove: true } : {}),
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
    case 'deep_water_run_update':
      return wrapTool(inputSummary, () => runDeepWaterRunUpdateTool(context, args))
    case 'email_list':
      return wrapTool(inputSummary, () => runEmailListTool(context, args))
    case 'email_read':
      return wrapTool(inputSummary, () => runEmailReadTool(context, args))
    case 'email_send':
      return wrapTool(inputSummary, () => runEmailSendTool(context, args))
    case 'comms_connect_card':
      return wrapTool(inputSummary, () => runCommsConnectCardTool(context, args))
    case 'meeting_link_create':
      return wrapTool(inputSummary, () => runMeetingLinkCreateTool(context, args))
    case 'call_start':
      return wrapTool(inputSummary, () => runCallStartTool(context, args))
    case 'gmail_search':
      return wrapTool(inputSummary, () => runGmailSearchTool(context, args))
    case 'gmail_thread_read':
      return wrapTool(inputSummary, () => runGmailThreadReadTool(context, args))
    case 'gmail_message_read':
      return wrapTool(inputSummary, () => runGmailMessageReadTool(context, args))
    case 'gmail_draft_create':
      return wrapTool(inputSummary, () => runGmailDraftCreateTool(context, args))
    case 'gmail_draft_update':
      return wrapTool(inputSummary, () => runGmailDraftUpdateTool(context, args))
    case 'gmail_draft_send':
      return wrapTool(inputSummary, () => runGmailDraftSendTool(context, args))
    case 'calendar_list':
      return wrapTool(inputSummary, () => runCalendarListTool(context, args))
    case 'calendar_events_list':
      return wrapTool(inputSummary, () => runCalendarEventsListTool(context, args))
    case 'calendar_freebusy':
      return wrapTool(inputSummary, () => runCalendarFreeBusyTool(context, args))
    case 'calendar_event_create':
      return wrapTool(inputSummary, () => runCalendarEventCreateTool(context, args))
    case 'calendar_event_update':
      return wrapTool(inputSummary, () => runCalendarEventUpdateTool(context, args))
    case 'calendar_event_cancel':
      return wrapTool(inputSummary, () => runCalendarEventCancelTool(context, args))
    case 'calendar_event_respond':
      return wrapTool(inputSummary, () => runCalendarEventRespondTool(context, args))
    case 'gmail_labels_list':
      return wrapTool(inputSummary, () => runGmailLabelsListTool(context, args))
    case 'gmail_organise':
      return wrapTool(inputSummary, () => runGmailOrganiseTool(context, args))
    case 'gmail_attachment_read':
      return wrapTool(inputSummary, () => runGmailAttachmentReadTool(context, args))
    case 'contacts_search':
      return wrapTool(inputSummary, () => runContactsSearchTool(context, args))
    case 'mailbox_search':
      return wrapTool(inputSummary, () => runMailboxSearchTool(context, args))
    case 'mailbox_read':
      return wrapTool(inputSummary, () => runMailboxReadTool(context, args))
    case 'mailbox_send':
      return wrapTool(inputSummary, () => runMailboxSendTool(context, args))
    default:
      return { inputSummary, output: 'Unknown tool: ' + toolName, success: false }
  }
}

export const executeBuiltinTool = async (
  toolName: string,
  args: Record<string, unknown>,
  context: BuiltinToolRuntimeContext,
  stubbedIds: ReadonlySet<string> = new Set(),
): Promise<AgenticToolResult> => {
  const result = await executeBuiltinToolUncorrected(toolName, args, context)
  return appendStubbedBuiltinSchema(
    toolName,
    result,
    stubbedIds,
    BUILTIN_TOOL_DEFINITIONS,
  )
}
