import type { RunExecuteJobPayload } from '@nessie/schemas'

import { isInteractiveRun } from './continuation.js'
import type { ExecutionDependencies, RunContext } from './types.js'
import { classifyWatchDisposition, isRollingStatusEnabled } from './watch-status.js'

/**
 * Decide whether this run's text is a finding to post or a quiet status roll.
 *
 * Two gates, in order. First structural, and cheap: only an unattended run
 * belonging to a recurring trigger that has not opted out is eligible, so an
 * @mention or a workflow step can never be folded away. Only then does the
 * model judge the text — one small utility call, and it fails open, because a
 * missed finding is far worse than one redundant message.
 */
export const resolveRollingWatch = async (
  deps: ExecutionDependencies,
  payload: RunExecuteJobPayload,
  context: RunContext,
  input: {
    responseText: string
    runUtility: (
      messages: Array<{ content: string; role: 'system' | 'user' }>,
      tools: [],
    ) => Promise<{ outputText: string }>
  },
): Promise<{ triggerId: string } | null> => {
  if (isInteractiveRun(payload)) return null
  if (!input.responseText.trim()) return null

  const run = await deps.prisma.run.findUnique({
    select: { triggerId: true },
    where: { id: context.run.id },
  })
  if (!run?.triggerId) return null

  const trigger = await deps.prisma.agentTrigger.findUnique({
    select: { config: true, type: true },
    where: { id: run.triggerId },
  })
  if (!trigger) return null
  if (trigger.type !== 'interval' && trigger.type !== 'scheduled') return null
  if (!isRollingStatusEnabled(trigger.config)) return null

  const disposition = await classifyWatchDisposition(
    input.runUtility,
    input.responseText,
  )
  return disposition === 'status' ? { triggerId: run.triggerId } : null
}
