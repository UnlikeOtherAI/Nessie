import type { PrismaClient } from '@prisma/client'
import {
  accessCheckVerdict,
  formatAccessCheckContext,
  type AccessCheckContext,
  type AccessCheckResult,
  type AccessCheckStep,
  type AccountKind,
  type AuthorizedActionContext,
} from '@nessie/schemas'

import { loadAccount } from '../account-reads.js'
import type { AccountViewer } from '../account-sources.js'
import { contextPhrase, loadCheckAgent, resolveCheckContext } from './check-context.js'
import { checkGoogle } from './check-google.js'
import { checkMailbox } from './check-mailbox.js'
import { checkAiPlan, checkApp, checkBrowser } from './check-other.js'

/**
 * Check access (plan §6.7, §10.13): for one agent, one account and one place
 * it could be asked from, each step the runtime takes, in order, in words,
 * with the one remedy the viewer may take for the first that fails.
 *
 * Every refusal before the steps is a plain "not found": an account, an agent
 * or a conversation the viewer cannot see answers exactly as one that does
 * not exist, so a check never reveals somebody else's account, agent or room.
 */

export type AccessCheckOutcome =
  | { kind: 'result'; result: AccessCheckResult }
  | { kind: 'not_found'; what: 'account' | 'agent' | 'context' }
  | { kind: 'not_applicable'; message: string }

const summarise = (
  agentName: string,
  phrase: string,
  verdict: AccessCheckResult['verdict'],
  steps: readonly AccessCheckStep[],
): string => {
  if (verdict === 'refused') {
    const first = steps.find((entry) => entry.outcome === 'fail')
    return `${agentName} cannot use this account ${phrase}. ${first?.reason.sentence ?? ''}`.trim()
  }
  return verdict === 'allowed_with_approval'
    ? `${agentName} may use this account ${phrase}. Some of what it does waits for approval first.`
    : `${agentName} may use this account ${phrase}.`
}

export const runAccessCheck = async (
  prisma: PrismaClient,
  viewer: AccountViewer,
  actor: AuthorizedActionContext,
  input: { agentId: string; context: AccessCheckContext; target: { id: string; kind: AccountKind } },
): Promise<AccessCheckOutcome> => {
  const account = await loadAccount(prisma, viewer, input.target)
  if (!account) return { kind: 'not_found', what: 'account' }
  if (account.agents.rule === 'not_used') {
    return {
      kind: 'not_applicable',
      message: 'No agent uses this account directly, so there is no access to check.',
    }
  }
  const agent = await loadCheckAgent(prisma, viewer, input.agentId)
  if (!agent) return { kind: 'not_found', what: 'agent' }
  const context = await resolveCheckContext(prisma, viewer, actor, agent, input.context)
  if (!context) return { kind: 'not_found', what: 'context' }

  const shared = { account, agent, context }
  const steps = input.target.kind === 'mailbox'
    ? await checkMailbox(prisma, viewer, actor, { ...shared, connectionId: input.target.id })
    : input.target.kind === 'comms'
      ? await checkGoogle(prisma, viewer, actor, { ...shared, connectionId: input.target.id })
      : input.target.kind === 'app'
        ? await checkApp(prisma, viewer, { ...shared, id: input.target.id })
        : input.target.kind === 'ai-plan'
          ? await checkAiPlan(prisma, viewer, { ...shared, id: input.target.id })
          : await checkBrowser(prisma, viewer, { ...shared, id: input.target.id })
  const verdict = accessCheckVerdict(steps)
  return {
    kind: 'result',
    result: {
      accountId: account.id,
      agentId: agent.id,
      context: formatAccessCheckContext(input.context),
      steps,
      summary: summarise(agent.name, contextPhrase(context), verdict, steps),
      verdict,
    },
  }
}
