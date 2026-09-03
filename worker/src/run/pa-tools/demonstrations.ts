import {
  startDemonstration,
  stopActiveDemonstration,
} from '@nessie/team-admin'
import { z } from 'zod'

import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { resolveActingMember } from './access.js'

const EmptyInputSchema = z.object({}).strict()

/**
 * Conversational arming is model-judged: the model invokes these structural
 * controls only when the person asks to demonstrate a routine. They share the
 * exact API operation, including live membership and channel reach checks.
 */
export const runDemonstrationStartTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  EmptyInputSchema.parse(input)
  const member = await resolveActingMember(context)
  const result = await startDemonstration(context.prisma, {
    actorContext: member.actorContext,
    agentId: context.agentId,
    channelId: context.channel.id,
    threadId: context.run.threadId,
  })
  context.demonstrationControl?.setActive(result.demonstration.id)
  return {
    inputSummary: 'current agent and thread',
    outputPreview: result.created
      ? `Recording started for this conversation (demonstration ${result.demonstration.id}). I will retain only completed tool calls with redacted arguments until you ask me to stop.`
      : `Recording is already active for this conversation (demonstration ${result.demonstration.id}).`,
    toolName: 'demonstration_start',
  }
}

export const runDemonstrationStopTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  EmptyInputSchema.parse(input)
  const member = await resolveActingMember(context)
  const demonstration = await stopActiveDemonstration(context.prisma, {
    actorContext: member.actorContext,
    agentId: context.agentId,
    threadId: context.run.threadId,
  })
  context.demonstrationControl?.clearActive()
  return {
    inputSummary: 'current agent and thread',
    outputPreview: demonstration
      ? `Recording stopped after ${demonstration.stepCount} completed tool calls. The captured trace is review-only; it will not run anything.`
      : 'There is no recording you started for this conversation.',
    toolName: 'demonstration_stop',
  }
}
