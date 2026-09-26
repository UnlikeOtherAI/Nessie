import type { PrismaClient } from '@prisma/client'
import { resolveConnectionForRun } from '@nessie/browser-cloud'
import { isMcpRegistryRowExposed } from '@nessie/mcp-manage'
import { loadSpendableSubscription } from '@nessie/model-subscriptions'
import { BROWSER_OPEN_TOOL_ID, isExplicitToolGranted } from '@nessie/runtime'
import type { AccessCheckStep, AccountRecord } from '@nessie/schemas'

import type { AccountViewer } from '../account-sources.js'
import {
  accountStep,
  agentToolsHref,
  fail,
  pass,
  placementStep,
  skip,
  warn,
  type CheckAgent,
  type CheckContext,
} from './check-context.js'

type Input = { account: AccountRecord; agent: CheckAgent; context: CheckContext; id: string }

/**
 * A person's own app connection: its capabilities reach any agent in its
 * owner's own runs unless an agent's policy says no — `isMcpRegistryRowExposed`,
 * the rule the worker applies to every capability it offers a run.
 */
export const checkApp = async (
  prisma: PrismaClient,
  viewer: AccountViewer,
  { account, agent, context, id }: Input,
): Promise<AccessCheckStep[]> => {
  const instance = await prisma.mcpServerInstance.findFirstOrThrow({
    select: {
      scopeId: true,
      scopeType: true,
      toolRegistryEntries: { select: { id: true, metadata: true }, where: { enabled: true, status: 'active' } },
    },
    where: { id, organizationId: viewer.organizationId },
  })
  const rows = instance.toolRegistryEntries
  const steps: AccessCheckStep[] = [accountStep(account, true)]
  steps.push(rows.length > 0
    ? pass('provider', 'Provider permits it', 'capabilities', `It offers ${rows.length === 1
      ? '1 capability' : `${rows.length} capabilities`}.`)
    : fail('provider', 'Provider permits it', 'no_capabilities', 'It offers no capabilities yet.', null))
  const policy = (agent.toolPolicy ?? {}) as Record<string, boolean>
  const denied = rows.length > 0 && rows.every((row) => policy[row.id] === false)
  steps.push(denied
    ? fail('agent', 'Agent allowed', 'denied_by_policy', `This app is turned off for ${agent.name}.`,
      { code: 'ask_owner', href: null, label: 'Ask an organisation owner' })
    : pass('agent', 'Agent allowed', 'requester_rule',
      `Any agent you talk to may use your own connection in your own conversations, ${agent.name} included.`))
  steps.push(skip('tools', 'Agent’s own tools', 'no_tool_switch', 'An app needs no separate tool switch.'))
  const placement = placementStep(agent, context)
  if (placement) {
    steps.push(placement)
  } else {
    const run = {
      agentKind: agent.agentKind,
      channelId: context.channel?.id ?? '',
      effectiveUserId: context.effectiveUserId,
      isPersonalAssistantPresence: false,
      projectId: null,
      teamId: context.teamId,
    }
    const exposed = rows.filter((row) => isMcpRegistryRowExposed(
      policy, row.id, instance, run, row.metadata, [], agent.id, '',
    ))
    steps.push(exposed.length > 0
      ? pass('context', 'Asked from here', 'reachable', 'You are asking, so your own connection is reached.')
      : fail('context', 'Asked from here', context.effectiveUserId ? 'not_the_owner' : 'nobody_asking',
        context.effectiveUserId
          ? 'Only its owner’s own requests reach this connection.'
          : 'Nobody is asking, so a personal connection is never reached.',
        null))
  }
  steps.push(skip('policy', 'Rules and approvals', 'no_approval', 'Using an app does not stop for approval.'))
  return steps
}

/**
 * A personal AI plan: every run of an agent its owner owns and pinned to the
 * plan spends the plan, whoever asks — the rule `resolveRunSubscriptionBinding`
 * admits a run by, through the same `loadSpendableSubscription` it calls.
 */
export const checkAiPlan = async (
  prisma: PrismaClient,
  viewer: AccountViewer,
  { account, agent, id }: Input,
): Promise<AccessCheckStep[]> => {
  const steps: AccessCheckStep[] = [accountStep(account, true)]
  steps.push(skip('provider', 'Provider permits it', 'no_provider_permission', 'A plan needs no permission per use.'))
  const owned = agent.ownerUserId !== null && agent.ownerUserId === viewer.userId
  steps.push(owned
    ? pass('agent', 'Agent allowed', 'owned_agent', `You own ${agent.name}, so it may run on your plan.`)
    : fail('agent', 'Agent allowed', 'not_owned', 'Only agents you own run on your plan.', null))
  const pinned = agent.modelSubscriptionId === id && (agent.provider ?? '').startsWith('subscription/')
  steps.push(pinned
    ? pass('tools', 'Runs on it', 'pinned', `${agent.name} runs on this plan.`)
    : fail('tools', 'Runs on it', 'not_pinned', `${agent.name} runs on another model.`,
      owned
        ? { code: 'finish_setup', href: `/admin/agents/${agent.id}`, label: `Choose this plan for ${agent.name}` }
        : null))
  if (owned && pinned) {
    try {
      await loadSpendableSubscription({ prisma, secretStore: null }, {
        expectedOwnerUserId: agent.ownerUserId ?? undefined,
        organizationId: viewer.organizationId,
        subscriptionId: id,
      })
      steps.push(pass('context', 'Asked from here', 'any_run', `Every run of ${agent.name} uses your plan, whoever asks.`))
    } catch {
      steps.push(fail('context', 'Asked from here', 'not_spendable',
        'Runs cannot use the plan as it stands; the first step says why.', null))
    }
  } else {
    steps.push(skip('context', 'Asked from here', 'after_earlier_steps', 'Checked once the steps above pass.'))
  }
  steps.push(pass('policy', 'Rules and approvals', 'plan_pays',
    'Organisation budgets do not limit it: your plan pays, never the organisation.'))
  return steps
}

/**
 * A cloud browser account: the agent needs the browser grant, and a run uses
 * the account `resolveConnectionForRun` picks — the most specific one the run
 * reaches unless a level above locked the choice. A run's requester is the
 * presence principal of a Personal Assistant, never an ordinary asker.
 */
export const checkBrowser = async (
  prisma: PrismaClient,
  viewer: AccountViewer,
  { account, agent, context, id }: Input,
): Promise<AccessCheckStep[]> => {
  const steps: AccessCheckStep[] = [accountStep(account, account.actions.length > 0)]
  steps.push(skip('provider', 'Provider permits it', 'no_provider_permission', 'The key is the whole permission.'))
  steps.push(isExplicitToolGranted(agent.toolPolicy, BROWSER_OPEN_TOOL_ID)
    ? pass('agent', 'Agent allowed', 'browser_granted', `${agent.name} may use the cloud browser.`)
    : fail('agent', 'Agent allowed', 'browser_not_granted', `${agent.name} has not been given the cloud browser.`,
      viewer.isOwner
        ? { code: 'turn_on_tools', href: agentToolsHref(agent.id), label: 'Give it the cloud browser' }
        : { code: 'ask_owner', href: null, label: 'Ask an organisation owner' }))
  steps.push(skip('tools', 'Agent’s own tools', 'covered_by_grant', 'The grant above is the tool switch.'))
  const placement = placementStep(agent, context)
  if (placement) {
    steps.push(placement)
  } else {
    const resolved = await resolveConnectionForRun(prisma, {
      organizationId: viewer.organizationId,
      requestedByUserId: agent.agentKind === 'personal_assistant' ? context.effectiveUserId : null,
      teamId: context.teamId,
    })
    steps.push(!resolved
      ? fail('context', 'Asked from here', 'no_account_reached', 'No cloud browser account reaches runs here.', null)
      : resolved.id === id
        ? pass('context', 'Asked from here', 'this_account', 'Runs here use this account.')
        : warn('context', 'Asked from here', 'another_account', resolved.scope === 'organization'
          ? 'Runs here use the company’s account instead.'
          : resolved.scope === 'team'
            ? 'Runs here use the team’s account instead.'
            : 'Runs here use another account instead.'))
  }
  steps.push(skip('policy', 'Rules and approvals', 'per_action',
    'An action that changes a site after signing in can still ask first.'))
  return steps
}
