import type { PrismaClient } from '@prisma/client'
import type { AccessCheckStep, AuthorizedActionContext } from '@nessie/schemas'
import { checkPolicy } from '@nessie/team-admin'

import { fail, pass, warn, type CheckAgent, type CheckContext } from './check-context.js'

/**
 * The last step: the organisation's access rules for the tool that reads the
 * account (`checkPolicy`, the shared evaluator behind the worker's own
 * decision, with the same allow-by-default), then what a send still needs —
 * which each kind states, because a send's approval is declared on the tool
 * and decided by its own gate, not by a rule.
 */
export const policyStep = async (
  prisma: PrismaClient,
  actor: AuthorizedActionContext,
  input: {
    agent: CheckAgent
    context: CheckContext
    readToolId: string
    /** What sending needs, or null where the account cannot send. */
    send: { outcome: 'pass' | 'warn'; sentence: string } | null
  },
): Promise<AccessCheckStep> => {
  const decision = await checkPolicy(prisma, actor, 'tool', 'invoke', {
    agentId: input.agent.id,
    ...(input.context.channel ? { channelId: input.context.channel.id } : {}),
    toolId: input.readToolId,
  }, { defaultVerdict: 'allow' })
  const label = 'Rules and approvals'
  if (!decision.allowed && decision.reasonCode !== 'APPROVAL_REQUIRED') {
    return fail('policy', label, 'access_rule_denies', 'An access rule stops it using this account here.',
      { code: 'ask_owner', href: null, label: 'Ask an organisation owner' })
  }
  const useNeedsApproval = decision.reasonCode === 'APPROVAL_REQUIRED'
  const first = useNeedsApproval
    ? 'An access rule asks for approval each time it uses this account here.'
    : 'No access rule stops it here.'
  if (!input.send) {
    return useNeedsApproval
      ? warn('policy', label, 'use_needs_approval', first)
      : pass('policy', label, 'no_rule', first)
  }
  const sentence = `${first} ${input.send.sentence}`
  return useNeedsApproval || input.send.outcome === 'warn'
    ? warn('policy', label, useNeedsApproval ? 'use_needs_approval' : 'send_needs_approval', sentence)
    : pass('policy', label, 'send_without_asking', sentence)
}
