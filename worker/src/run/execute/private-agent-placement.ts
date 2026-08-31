import type { RunContext } from './types.js'

export class PrivateAgentPlacementError extends Error {
  override readonly name = 'PrivateAgentPlacementError'
  readonly code = 'PRIVATE_AGENT_INVALID_PLACEMENT'

  constructor() {
    super('Private agents may only run in their owner home DM or their own trigger thread.')
  }
}

/**
 * The binding trigger is the durable floor, but old/manual rows can survive a
 * deployment. Re-check the loaded destination before any provider work so a
 * malformed binding cannot turn a private agent into a shared-room speaker.
 */
export const assertPrivateAgentRunPlacement = (context: RunContext): void => {
  if (context.agent.visibility !== 'private') return

  const expectedHomeDmKey = context.agent.ownerUserId
    ? `agent:${context.channel.organizationId}:${context.agent.ownerUserId}:${context.agent.id}`
    : null
  const isHome = expectedHomeDmKey !== null && context.channel.dmKey === expectedHomeDmKey
  const isOwnTriggerThread = context.run.trigger?.agentId === context.agent.id
    && context.run.trigger.targetThreadId === context.run.threadId

  if (!isHome && !isOwnTriggerThread) {
    throw new PrivateAgentPlacementError()
  }
}
