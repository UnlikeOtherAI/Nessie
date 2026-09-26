import type { PrismaClient } from '@prisma/client'
import { MAILBOX_READ_TOOL_ID } from '@nessie/runtime'
import type { AccessCheckStep, AccountRecord, AuthorizedActionContext } from '@nessie/schemas'
import { listReachableMailboxes } from '@nessie/team-admin'

import { mailboxToolsState } from '../account-grants-read.js'
import type { AccountViewer } from '../account-sources.js'
import {
  accountHref,
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
import { policyStep } from './check-policy.js'

/**
 * A mailbox at another provider takes two decisions and one live requester
 * (`docs/standards/connected-mailboxes.md`): the per-agent access row, the
 * agent's own mailbox tools, and — for a personal mailbox — its owner asking.
 * Reachability is `listReachableMailboxes`, the very list a tool call picks
 * from, so the answer here cannot drift from the run's.
 */
export const checkMailbox = async (
  prisma: PrismaClient,
  viewer: AccountViewer,
  actor: AuthorizedActionContext,
  input: { account: AccountRecord; agent: CheckAgent; connectionId: string; context: CheckContext },
): Promise<AccessCheckStep[]> => {
  const { account, agent, connectionId, context } = input
  const connection = await prisma.mailboxConnection.findFirstOrThrow({
    select: { createdByUserId: true, ownerUserId: true, teamId: true },
    where: { id: connectionId, organizationId: viewer.organizationId },
  })
  const canManage = account.agents.canManage
  const steps: AccessCheckStep[] = [accountStep(account, canManage)]

  steps.push(skip('provider', 'Provider permits it', 'no_provider_permission',
    'A mailbox at another provider needs only its password.'))

  const row = await prisma.mailboxConnectionAgentAccess.findFirst({
    select: { id: true },
    where: { agentId: agent.id, connectionId },
  })
  steps.push(row
    ? pass('agent', 'Agent allowed', 'access_row', `${agent.name} may use this mailbox.`)
    : fail('agent', 'Agent allowed', 'no_access_row', `${agent.name} has not been allowed to use this mailbox.`,
      canManage
        ? { code: 'allow_agent', href: accountHref(account), label: `Allow ${agent.name} on the mailbox` }
        : { code: 'ask_admin', href: null, label: 'Ask an owner or admin to allow it' }))

  steps.push(mailboxToolsState(agent.toolPolicy) === 'on'
    ? pass('tools', 'Agent’s own tools', 'mailbox_tools_on', `${agent.name}’s mailbox tools are on.`)
    : fail('tools', 'Agent’s own tools', 'mailbox_tools_off',
      `${agent.name}’s mailbox tools are off, so it cannot reach any mailbox.`,
      viewer.isOwner
        ? { code: 'turn_on_tools', href: agentToolsHref(agent.id), label: 'Turn on its mailbox tools' }
        : { code: 'ask_owner', href: null, label: 'Ask an organisation owner to turn them on' }))

  const placement = placementStep(agent, context)
  if (placement) {
    steps.push(placement)
  } else if (steps.some((entry) => entry.outcome === 'fail')) {
    steps.push(skip('context', 'Asked from here', 'after_earlier_steps',
      'Checked once the steps above pass.'))
  } else {
    const reachable = await listReachableMailboxes(prisma, {
      agentId: agent.id,
      effectiveUserId: context.effectiveUserId,
      organizationId: viewer.organizationId,
    })
    const reached = reachable.some((entry) => entry.connection.id === connectionId)
    if (!reached) {
      steps.push(fail('context', 'Asked from here', 'personal_needs_owner',
        context.effectiveUserId
          ? 'A personal mailbox is reached only when the person who connected it asks.'
          : 'Nobody is asking, so a personal mailbox is never reached.',
        null))
    } else if (reachable.length > 1) {
      steps.push(warn('context', 'Asked from here', 'several_mailboxes',
        `${agent.name} can reach ${reachable.length} mailboxes here, so it asks which one to use.`))
    } else {
      steps.push(pass('context', 'Asked from here', 'reachable',
        connection.ownerUserId
          ? 'You are asking, so your own mailbox is reached. What it reads from it is shown only to you.'
          : 'A shared mailbox is reached wherever the agent is asked.'))
    }
  }

  // Every send is approved and pinned: the owner of a personal mailbox, or
  // whoever connected a shared one (`evaluateMailboxSendGate`).
  const approver = connection.ownerUserId
    ? connection.ownerUserId === viewer.userId ? 'you' : 'its owner'
    : connection.createdByUserId === viewer.userId ? 'you' : 'the person who connected it'
  steps.push(await policyStep(prisma, actor, {
    agent,
    context,
    readToolId: MAILBOX_READ_TOOL_ID,
    send: { outcome: 'warn', sentence: `Every message it sends waits for ${approver} to approve it.` },
  }))
  return steps
}
