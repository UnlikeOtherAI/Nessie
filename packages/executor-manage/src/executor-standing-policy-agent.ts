import { createHash } from 'node:crypto'
import type { Prisma, PrismaClient } from '@prisma/client'
import { stableStringify } from '@nessie/db'
import { StandingPolicyPinnedTermsSchema, type StandingPolicyAgentPin } from '@nessie/schemas'

import { suspendStandingPolicyInTransaction, type StandingPolicyActor } from './executor-standing-policy-lifecycle.js'

/**
 * What a standing policy pins about its agent
 * (docs/standards/ticket-work-machine-access.md → "What is pinned"): a team
 * agent can be edited by other members than the policy's author, and the
 * agent is what drives the author's machines — so its definition is part of
 * what the author agreed to. The digest covers its written instructions (the
 * system prompt, its role, and the published versions of its core documents),
 * how it thinks (provider, model, subscription, local binding, routing,
 * execution and delegation modes), its tool policy with every explicit grant,
 * and its connector grants. The provider and model are kept beside the digest
 * for the card to show.
 *
 * Any change suspends a live policy (`agent_changed`): in the transactions
 * that edit the agent, its tool policy and its connectors
 * (`suspendStandingPoliciesForAgentChangeInTransaction`), and at the next bind
 * for anything else — a core document published, say — whose digest no
 * longer matches.
 */

type Client = PrismaClient | Prisma.TransactionClient

const AGENT_SELECT = {
  delegationMode: true, executionMode: true, localInferenceBindingId: true, model: true, modelSubscriptionId: true,
  provider: true, role: true, routingProfileId: true, systemPrompt: true, toolPolicy: true,
  coreDocuments: { select: { page: { select: { publishedVersionId: true } }, role: true } },
} as const

/** The agent as a standing policy pins it now; null when it is gone. */
export const loadStandingPolicyAgentPin = async (
  client: Client,
  agentId: string,
): Promise<StandingPolicyAgentPin | null> => {
  const [agent, grants] = await Promise.all([
    client.agent.findFirst({ where: { deletedAt: null, id: agentId }, select: AGENT_SELECT }),
    client.toolGrant.findMany({ where: { agentId }, select: { config: true, state: true, toolId: true } }),
  ])
  if (!agent) return null
  const { coreDocuments, ...definition } = agent
  const pinned = {
    ...definition,
    connectors: grants
      .map((grant) => ({ config: grant.config, state: grant.state, toolId: grant.toolId }))
      .sort((left, right) => left.toolId.localeCompare(right.toolId) || left.state.localeCompare(right.state)),
    coreDocuments: coreDocuments
      .map((document) => ({ role: document.role, version: document.page.publishedVersionId }))
      .sort((left, right) => left.role.localeCompare(right.role)),
  }
  return {
    digest: `sha256:${createHash('sha256').update(stableStringify(pinned)).digest('hex')}`,
    model: agent.model,
    provider: agent.provider,
  }
}

/**
 * The agent was edited, or its tool policy or connectors were: every live
 * policy that pins a different agent definition than it has now is
 * suspended (`agent_changed`), in the caller's transaction, whoever saved it.
 */
export const suspendStandingPoliciesForAgentChangeInTransaction = async (
  tx: Prisma.TransactionClient,
  input: { actor: StandingPolicyActor; agentId: string },
): Promise<string[]> => {
  const policies = await tx.executorStandingPolicy.findMany({
    where: { agentId: input.agentId, status: 'live' },
    select: { id: true, pinnedTerms: true },
  })
  if (policies.length === 0) return []
  const current = await loadStandingPolicyAgentPin(tx, input.agentId)
  const suspended: string[] = []
  for (const policy of policies) {
    const pinned = StandingPolicyPinnedTermsSchema.safeParse(policy.pinnedTerms)
    if (pinned.success && current && pinned.data.agent.digest === current.digest) continue
    if (await suspendStandingPolicyInTransaction(tx, {
      actor: input.actor,
      detail: { changed: ['the agent'] },
      policyId: policy.id,
      reason: 'agent_changed',
    })) suspended.push(policy.id)
  }
  return suspended
}
