import { parseAgentId, parseUserId, type AuthorizedActionContext } from '@nessie/schemas'
import { prepareStandingPolicy, StandingPolicyRefusal } from '@nessie/team-admin'

import { resolveDelegatedRequesterUserId, runDelegatesToRequestingPerson } from '../delegated-identity.js'
import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { postAgentCard } from './agent-card-post.js'

/**
 * `executor_standing_policy_prepare`: a ticket trigger's standing machine
 * access, as the one card its author confirms
 * (docs/plans/2026-09-23-ticket-driven-agents/machine-access.md → "Prepare and
 * confirm"; docs/standards/ticket-work.md).
 *
 * Only on an interactive turn by a live person, in that person's own Agent
 * Designer or Personal Assistant conversation — never a shared room, somebody
 * else's DM or an unattended run — and only for a trigger that person set up
 * (the service refuses anyone else by name). So the card lands in the
 * author's own DM and nowhere a project audience reads, and nobody learns
 * another person's private machines by asking. The token the prepare minted
 * is discarded unseen: the card's Review mints the one that confirms, for the
 * author alone, and the model is told only that the card was posted.
 */

const SURFACE_REFUSAL = 'Machine access is set up only by the person who set up the trigger, on their own turn, '
  + 'in their own conversation with the Agent Designer or their Personal Assistant, or from the trigger\'s Machine '
  + 'access section. Say so, and name who can.'

const requireAuthorSurface = (context: BuiltinToolRuntimeContext): AuthorizedActionContext => {
  const runContext = context.runContext
  const requester = resolveDelegatedRequesterUserId({
    actorId: context.actorContext.actor.actorId,
    actorType: context.actorContext.actor.actorType,
    effectiveUserId: context.actorContext.actionContext.effectiveUserId,
    interactive: context.run.interactive === true,
  })
  if (
    !runContext
    || !requester
    || context.run.originatingUserId !== requester
    || !runDelegatesToRequestingPerson({
      agentKind: runContext.agent.agentKind,
      dmKey: runContext.channel.dmKey,
      organizationId: runContext.channel.organizationId,
      systemChannelType: runContext.channel.systemChannelType,
      systemSlug: runContext.agent.systemSlug,
    })
  ) {
    throw new Error(SURFACE_REFUSAL)
  }
  return {
    ...context.actorContext,
    actor: { actorId: parseUserId(requester), actorType: 'user' },
    actionContext: {
      ...context.actorContext.actionContext,
      agentId: parseAgentId(context.agentId),
      effectiveUserId: parseUserId(requester),
    },
  }
}

export const runExecutorStandingPolicyPrepareTool = async (
  context: BuiltinToolRuntimeContext,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const actorContext = requireAuthorSurface(context)
  const runContext = context.runContext
  // Unreachable past the surface check, which requires one.
  if (!runContext) throw new Error(SURFACE_REFUSAL)
  let prepared
  try {
    prepared = await prepareStandingPolicy(context.prisma, actorContext, args)
  } catch (error) {
    // Plain words for the person, the machine reasons included.
    if (error instanceof StandingPolicyRefusal) throw new Error(error.message)
    throw error
  }
  await postAgentCard(context, runContext, {
    card: prepared.card,
    executorAccessChangeId: prepared.accessChangeId,
    expiresAt: prepared.expiresAt,
    respondentUserIds: [actorContext.actor.actorId],
  })
  return {
    // The card is this turn's message: it says what to do and what it means.
    deliveredToConversation: true,
    inputSummary: `triggerId=${String(args.triggerId)} machines=${Array.isArray(args.executorIds) ? args.executorIds.length : 0}`,
    outputPreview:
      'Prepared machine access for the trigger and put ONE confirmation card in this conversation. It says in '
      + 'plain words who can start work, on which machines, with which limits and instructions; its Review opens '
      + 'the exact change for the person, and nothing is applied until they confirm it there with their password. '
      + `It expires at ${prepared.expiresAt.toISOString()}. Do not prepare the agent's machine access separately: `
      + 'this card covers it.',
    toolName: 'executor_standing_policy_prepare',
  }
}
