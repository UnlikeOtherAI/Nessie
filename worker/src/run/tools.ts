import { BUILTIN_TOOL_DEFINITIONS } from '@nessie/runtime'
import { appendStubbedBuiltinSchema } from './builtin-toolset-deferred.js'
import { resolveDashboardToolServices } from './pa-tools/dashboard-context.js'
import { runDashboardTool } from './pa-tools/dashboards.js'
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
  runTicketArchiveDoneTool,
  runTicketAssignTool,
  runTicketBoardReadTool,
  runTicketCreateTool,
  runTicketIterationSetTool,
  runTicketListTool,
  runTicketMoveTool,
  runTicketReadTool,
  runTicketTransitionTool,
  runTicketUpdateTool,
  runUpdatePreferencesTool,
  runTodoStartTool,
  runTodoStepUpdateTool,
  runTodoTemplateProposeTool,
  runWorkflowTransformPreviewTool,
  runWorkflowCreateTool,
  runWorkflowInstallTool,
  runWorkflowListTool,
  runWorkflowPreviewTool,
  runWorkflowRunStatusTool,
  runWorkflowRunTool,
  runWorkflowTriggerCreateTool,
  runWorkflowUpdateTool,
  runTeamSearchTool,
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
  coercePage,
  runDocumentReadTool,
  runWebFetchTool,
  runWebSearchTool,
} from './content-tools.js'
import { runSpawnSubtaskTool } from './subtask-tools.js'
import { executeBuiltinFileTool } from './builtin-file-dispatch.js'
import { executeMailBuiltinTool } from './mail-builtin-dispatch.js'
import { summarizeToolInputForTool, wrapTool } from './tool-util.js'
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

/**
 * The dashboard dispatcher is injected only by unit tests so the top-level
 * builtin routing contract can be verified without constructing a deployment
 * storage service. Production always uses the shared service resolver below.
 */
export type BuiltinToolDependencies = {
  dashboard?: {
    resolveServices: typeof resolveDashboardToolServices
    runTool: typeof runDashboardTool
  }
}

const DEFAULT_BUILTIN_TOOL_DEPENDENCIES: Required<BuiltinToolDependencies> = {
  dashboard: {
    resolveServices: resolveDashboardToolServices,
    runTool: runDashboardTool,
  },
}
const executeBuiltinToolUncorrected = async (
  toolName: string,
  args: Record<string, unknown>,
  context: BuiltinToolRuntimeContext,
  dependencies: BuiltinToolDependencies = DEFAULT_BUILTIN_TOOL_DEPENDENCIES,
): Promise<AgenticToolResult> => {
  const inputSummary = summarizeToolInputForTool(toolName, args)
  const executorTool = executorManagementTool(toolName, args, context)
  if (executorTool) return wrapTool(inputSummary, executorTool)
  const connectorTool = connectorManagementTool(toolName, args, context)
  if (connectorTool) return wrapTool(inputSummary, connectorTool)
  const browserResult = cloudBrowserTool(toolName, args, context)
  if (browserResult) return browserResult
  const knowledgeBaseResult = dispatchKbTool(toolName, args, context, inputSummary)
  if (knowledgeBaseResult) return knowledgeBaseResult
  const mailToolResult = await executeMailBuiltinTool(toolName, args, context, inputSummary)
  if (mailToolResult) return mailToolResult
  const fileToolResult = await executeBuiltinFileTool(toolName, args, context, inputSummary)
  if (fileToolResult) return fileToolResult
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
    case 'workflow_create':
      return wrapTool(inputSummary, () => runWorkflowCreateTool(context, args))
    case 'workflow_update':
      return wrapTool(inputSummary, () => runWorkflowUpdateTool(context, args))
    case 'workflow_list':
      return wrapTool(inputSummary, () => runWorkflowListTool(context, args))
    case 'workflow_install':
      return wrapTool(inputSummary, () => runWorkflowInstallTool(context, args))
    case 'workflow_preview':
      return wrapTool(inputSummary, () => runWorkflowPreviewTool(context, args))
    case 'workflow_run':
      return wrapTool(inputSummary, () => runWorkflowRunTool(context, args))
    case 'workflow_run_status':
      return wrapTool(inputSummary, () => runWorkflowRunStatusTool(context, args))
    case 'workflow_trigger_create':
      return wrapTool(inputSummary, () => runWorkflowTriggerCreateTool(context, args))
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
    case 'ticket_list':
      return wrapTool(inputSummary, () => runTicketListTool(context, args))
    case 'ticket_read':
      return wrapTool(inputSummary, () => runTicketReadTool(context, args))
    case 'ticket_board_read':
      return wrapTool(inputSummary, () => runTicketBoardReadTool(context, args))
    case 'ticket_create':
      return wrapTool(inputSummary, () => runTicketCreateTool(context, args))
    case 'ticket_update':
      return wrapTool(inputSummary, () => runTicketUpdateTool(context, args))
    case 'ticket_assign':
      return wrapTool(inputSummary, () => runTicketAssignTool(context, args))
    case 'ticket_move':
      return wrapTool(inputSummary, () => runTicketMoveTool(context, args))
    case 'ticket_transition':
      return wrapTool(inputSummary, () => runTicketTransitionTool(context, args))
    case 'ticket_iteration_set':
      return wrapTool(inputSummary, () => runTicketIterationSetTool(context, args))
    case 'ticket_archive_done':
      return wrapTool(inputSummary, () => runTicketArchiveDoneTool(context, args))
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
    case 'dashboard_source_import':
    case 'dashboard_source_set_credential':
    case 'dashboard_widget_add':
    case 'dashboard_widget_update':
    case 'dashboard_widget_move':
    case 'dashboard_widget_remove':
    case 'dashboard_presentation_update':
    case 'dashboard_read':
    case 'dashboard_present':
    case 'dashboard_widget_post':
      return wrapTool(inputSummary, async () => {
        const dashboard = dependencies.dashboard ?? DEFAULT_BUILTIN_TOOL_DEPENDENCIES.dashboard
        const services = await dashboard.resolveServices(context.prisma)
        return dashboard.runTool(toolName, context, args, services)
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
    case 'deep_water_run_update':
      return wrapTool(inputSummary, () => runDeepWaterRunUpdateTool(context, args))
    case 'comms_connect_card':
      return wrapTool(inputSummary, () => runCommsConnectCardTool(context, args))
    case 'meeting_link_create':
      return wrapTool(inputSummary, () => runMeetingLinkCreateTool(context, args))
    case 'call_start':
      return wrapTool(inputSummary, () => runCallStartTool(context, args))
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
    default:
      return { inputSummary, output: 'Unknown tool: ' + toolName, success: false }
  }
}

export const executeBuiltinTool = async (
  toolName: string,
  args: Record<string, unknown>,
  context: BuiltinToolRuntimeContext,
  stubbedIds: ReadonlySet<string> = new Set(),
  dependencies: BuiltinToolDependencies = DEFAULT_BUILTIN_TOOL_DEPENDENCIES,
): Promise<AgenticToolResult> => {
  const result = await executeBuiltinToolUncorrected(toolName, args, context, dependencies)
  return appendStubbedBuiltinSchema(
    toolName,
    result,
    stubbedIds,
    BUILTIN_TOOL_DEFINITIONS,
  )
}
