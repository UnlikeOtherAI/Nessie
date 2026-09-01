import {
  CallLinkError,
  CallLinkProviderSchema,
  CallStartError,
  createCallLinkForTeamUser,
  publishCallStartedRealtime,
  startCallForUser,
} from '@nessie/workspace-admin'
import { z } from 'zod'

import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { resolveActingMember, resolveEffectiveUserId } from './access.js'

const MeetingLinkCreateInputSchema = z.object({
  teamId: z.string().uuid(),
  provider: CallLinkProviderSchema.optional(),
}).strict()

const CallStartInputSchema = z.object({
  channelId: z.string().uuid(),
  provider: CallLinkProviderSchema.optional(),
}).strict()

const requireRequestingUser = (context: BuiltinToolRuntimeContext): void => {
  if (resolveEffectiveUserId(context)) return
  throw new Error(
    'I can only create or start a call when a person asks me directly.',
  )
}

const rethrowCallLinkError = (error: CallLinkError): never => {
  const code = String(error.code)
  if (code === 'GOOGLE_NOT_CONNECTED') {
    throw new Error(
      'Connect Google at /settings/connections, then ask me to create the Meet link again.',
    )
  }
  if (code === 'MEET_SCOPE_MISSING') {
    throw new Error(
      'Reconnect Google at /settings/connections and grant the Meet space scope, then ask again.',
    )
  }
  if (code === 'GOOGLE_REAUTH_REQUIRED') {
    throw new Error(
      'Reconnect Google at /settings/connections, then ask me to create the Meet link again.',
    )
  }
  // Microsoft Teams is not connected yet in this deployment. Keep this typed
  // refusal ready for the provider adapter, rather than making intent depend
  // on a provider-name heuristic in the agent layer.
  if (code === 'MICROSOFT_NOT_CONNECTED') {
    throw new Error(
      'Connect Microsoft at /settings/connections, then ask me to create the Teams link again.',
    )
  }
  if (error.code === 'TEAM_NOT_FOUND') throw new Error('Team not found')
  if (error.code === 'MEET_LINK_FAILED') {
    throw new Error('Google Meet could not create a link. Try again shortly.')
  }
  throw new Error('The selected call provider is not configured.')
}

const rethrowCallStartError = (error: CallStartError): never => {
  if (error.code === 'CHANNEL_NOT_FOUND') throw new Error('Channel not found')
  if (error.code === 'CHANNEL_SYSTEM_MANAGED') {
    throw new Error('Calls are not available in the Personal Assistant DM')
  }
  if (error.code === 'CALL_REQUIRES_PARTICIPANTS') {
    throw new Error('Calls require at least two channel members')
  }
  throw new Error('An active call already exists for this channel')
}

export const runMeetingLinkCreateTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = MeetingLinkCreateInputSchema.parse(input)
  requireRequestingUser(context)
  const member = await resolveActingMember(context)

  try {
    const link = await createCallLinkForTeamUser(context.prisma, {
      teamId: args.teamId,
      userId: member.userId,
      ...(args.provider ? { provider: args.provider } : {}),
    })
    return {
      inputSummary: `teamId=${args.teamId}${args.provider ? ` provider=${args.provider}` : ''}`,
      outputPreview: JSON.stringify(link),
      toolName: 'meeting_link_create',
    }
  } catch (error) {
    if (error instanceof CallLinkError) rethrowCallLinkError(error)
    throw error
  }
}

export const runCallStartTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = CallStartInputSchema.parse(input)
  requireRequestingUser(context)
  const member = await resolveActingMember(context)

  try {
    // expectedOrganizationId is deliberately unset. The shared route seam
    // resolves the target channel and re-reads this user's live membership in
    // that channel's organisation, so a PA cannot carry home-org authority
    // into another UOA organisation.
    const call = await startCallForUser(context.prisma, {
      actingUserId: member.userId,
      channelId: args.channelId,
      createdViaAgentId: context.agentId,
      ...(args.provider ? { provider: args.provider } : {}),
    })

    // The REST route publishes this after committing. The channel banner is
    // best effort; durable ring jobs created by startCallForUser still deliver
    // the actual calls when a realtime publication is temporarily unavailable.
    try {
      await publishCallStartedRealtime(context.prisma, context.realtimeTransport, call.id)
    } catch {
      // Keep the committed call and its ring jobs, matching the REST route.
    }

    return {
      inputSummary: `channelId=${args.channelId}${args.provider ? ` provider=${args.provider}` : ''}`,
      outputPreview: JSON.stringify({
        callId: call.id,
        meetingUri: call.meetingUri,
        provider: call.provider,
        status: call.status,
      }),
      toolName: 'call_start',
    }
  } catch (error) {
    if (error instanceof CallStartError) rethrowCallStartError(error)
    if (error instanceof CallLinkError) rethrowCallLinkError(error)
    throw error
  }
}
