/**
 * Presenting a completed dashboard in the current conversation.
 *
 * The message stores only a dashboard id. Its preview reads the normal
 * viewer-scoped dashboard route, so this cannot turn a chat message into an
 * access grant or put dashboard data into message metadata.
 */

import { DashboardPresentationMessageMetadataSchema } from '@nessie/schemas'
import { assertDashboardAudienceForChannel } from '@nessie/dashboard'
import { isGlobalAgentHomeSurface } from '../delegated-identity.js'

import { createAgentMessage } from '../execute/agent-message.js'
import { applyRunReplyBookkeeping } from '../execute/lifecycle.js'
import { publishMessageCreated } from '../execute/realtime.js'
import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { buildDashboardContext, type DashboardToolServices } from './dashboard-context.js'

const dashboardPresentationContent = (title: string): string =>
  `Dashboard ready: ${title}`

export const runDashboardPresentTool = async (
  context: BuiltinToolRuntimeContext,
  args: Record<string, unknown>,
  services: DashboardToolServices,
): Promise<ToolExecutionResult> => {
  const dashboardId = String(args.dashboardId ?? '')
  if (!context.runContext) {
    return {
      inputSummary: `dashboardId=${dashboardId}`,
      outputPreview: 'Unable to resolve the current conversation.',
      toolName: 'dashboard_present',
    }
  }

  try {
    const dashboardContext = await buildDashboardContext(context, services)
    // This is the same resource read the viewer makes. It proves the current
    // acting person can already reach the dashboard before a message references
    // it, and it returns the stable title for the message copy.
    const dashboard = await services.getDashboardWithWidgets(dashboardContext, dashboardId)
    await assertDashboardAudienceForChannel(dashboardContext, {
      dashboardId: dashboard.id,
      channelId: context.channel.id,
      allowOwnerPersonalDm: context.runContext
        ? isGlobalAgentHomeSurface({
          agentKind: context.runContext.agent.agentKind,
          dmKey: context.runContext.channel.dmKey,
          organizationId: context.runContext.channel.organizationId,
          systemChannelType: context.runContext.channel.systemChannelType,
          systemSlug: context.runContext.agent.systemSlug,
        })
        : false,
    })
    const content = dashboardPresentationContent(dashboard.title)
    const message = await createAgentMessage(context.prisma, context.runContext, {
      agentId: context.agentId,
      content,
      metadata: DashboardPresentationMessageMetadataSchema.parse({
        dashboardPresentation: { dashboardId: dashboard.id, schemaVersion: 1 },
      }),
      role: 'assistant',
      threadId: context.run.threadId,
      ...(context.runContext.replyRootMessageId
        ? { rootMessageId: context.runContext.replyRootMessageId }
        : {}),
    })
    const reply = context.runContext.replyRootMessageId
      ? await applyRunReplyBookkeeping(context.prisma, context.runContext, message.createdAt)
      : undefined
    await publishMessageCreated(context.realtimeTransport, context.runContext, {
      content,
      messageId: message.id,
      restricted: message.basis.length > 0,
      role: 'assistant',
      ...(reply ? { reply } : {}),
    })

    return {
      inputSummary: `dashboardId=${dashboard.id}`,
      outputPreview:
        `Presented "${dashboard.title}" in this conversation. The preview stays access-controlled `
        + 'and opens in the conversation workspace when selected.',
      toolName: 'dashboard_present',
    }
  } catch (error) {
    return {
      inputSummary: `dashboardId=${dashboardId}`,
      outputPreview: error instanceof Error ? error.message : 'Unable to present that dashboard.',
      toolName: 'dashboard_present',
    }
  }
}
