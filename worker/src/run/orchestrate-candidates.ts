import { type OrchestratorAgent } from '@nessie/runtime'
import {
  type OrchestrateDecideJobPayload,
  parseUserId,
  withActionContext,
} from '@nessie/schemas'

export type ChannelAgent = OrchestratorAgent & { principalUserId?: string }

export const engagementIdFor = (agent: ChannelAgent): string =>
  agent.principalUserId ? `${agent.id}:${agent.principalUserId}` : agent.id

export const asEngagementCandidate = (agent: ChannelAgent): OrchestratorAgent =>
  agent.principalUserId
    ? { ...agent, engagementId: engagementIdFor(agent) }
    : agent

// The original poster starts the engagement, but a shared PA presence acts
// only as its own principal. Keep this at the orchestration boundary so run,
// tool, memory, and ledger consumers all receive the same effective identity.
export const runActorContextForCandidate = (
  actorContext: OrchestrateDecideJobPayload['actorContext'],
  candidate: ChannelAgent,
) =>
  candidate.principalUserId
    ? withActionContext(actorContext, {
        effectiveUserId: parseUserId(candidate.principalUserId),
      })
    : actorContext
