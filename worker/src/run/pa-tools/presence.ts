import { addPersonalAssistantPresence } from '@nessie/team-admin'
import { z } from 'zod'

import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { requireActingUserId } from './access.js'

const PersonalAssistantJoinChannelInputSchema = z.object({
  channelId: z.string().uuid(),
})

/**
 * The PA counterpart to POST /channels/:channelId/personal-assistant.
 *
 * This is intentionally available only in the owner's PA DM. A shared-channel
 * presence runs as that owner for identity, but a colleague must not be able to
 * move the owner's assistant around by issuing an instruction in the room.
 */
export const runPersonalAssistantJoinChannelTool = async (
  context: BuiltinToolRuntimeContext,
  input: unknown,
): Promise<ToolExecutionResult> => {
  if (
    context.agentKind !== 'personal_assistant'
    || context.channel.systemChannelType !== 'personal_assistant'
  ) {
    throw new Error(
      'Adding your Personal Assistant to a channel is available only in your Personal Assistant conversation.',
    )
  }

  const { channelId } = PersonalAssistantJoinChannelInputSchema.parse(input)
  const userId = requireActingUserId(context)
  const result = await addPersonalAssistantPresence(context.prisma, {
    channelId,
    organizationId: context.channel.organizationId,
    userId,
  })
  if (result.kind !== 'created') {
    throw new Error('Channel not found, or you are not an active member of it.')
  }

  return {
    inputSummary: `channelId=${channelId}`,
    outputPreview: `Your Personal Assistant is now available in channelId=${channelId}.`,
    toolName: 'pa_join_channel',
  }
}
