import { listCloudBrowserConnectionMetadata } from '@nessie/browser-cloud'
import { listUserSubscriptions, requireSubscriptionAdapter } from '@nessie/model-subscriptions'

import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { resolveActingMember } from './access.js'

/** The same entitled metadata reads as Settings, with no credential resolver. */
export const runAccountConnectionsListTool = async (
  context: BuiltinToolRuntimeContext,
): Promise<ToolExecutionResult> => {
  if (context.run.interactive !== true || context.actorContext.actor.actorType !== 'user') {
    throw new Error('Connected accounts can only be checked on the requesting person\'s live turn.')
  }
  const member = await resolveActingMember(context)
  if (member.userId !== context.actorContext.actor.actorId) {
    throw new Error('Connected accounts must be checked for the person making this request.')
  }
  // Even an empty personal inventory is information about this person.
  context.consumedSources?.add({ scopeId: member.userId, scopeType: 'user' })
  const [browsers, plans] = await Promise.allSettled([
    listCloudBrowserConnectionMetadata(context.prisma, {
      organizationId: member.organizationId, userId: member.userId,
      uoaIdentity: member.actorContext.actionContext.uoaIdentity,
    }),
    listUserSubscriptions({ prisma: context.prisma, secretStore: null }, {
      organizationId: member.organizationId,
      userId: member.userId,
      activeOnly: false,
    }),
  ])
  const browserLines = browsers.status === 'rejected'
    ? ['Browserbase connections could not be read. Their presence is unknown.']
    : browsers.value.length === 0
      ? ['No Browserbase connection is visible to this person in this organisation.']
      : browsers.value.map((row) =>
          `- Browserbase: scope=${row.scope}; status=${row.status}; health=${row.healthReason ?? 'unknown'}`
          + (row.teamId ? `; teamId=${row.teamId}` : ''))
  const planLines = plans.status === 'rejected'
    ? ['Personal model subscriptions could not be read. Their presence is unknown.']
    : plans.value.length === 0
      ? ['No personal model subscription is linked in this organisation.']
      : plans.value.map((row) => {
          const adapter = requireSubscriptionAdapter(row.provider)
          return `- ${adapter.displayName}: status=${row.status}; health=${row.healthReason}; `
            + `modelSubscriptionId=${row.id}; provider=subscription/${adapter.key}; `
            + `models=${adapter.models.map((model) => model.model).join(', ')}`
        })
  return {
    inputSummary: '',
    outputPreview: [
      'Connected accounts for the requesting person in this organisation:',
      ...browserLines,
      ...planLines,
      'Saved accounts do not grant an agent browser tools or choose its model. '
        + 'A personal model plan can run only an ordinary agent this person owns, '
        + 'after they choose it; Nessie-managed agents cannot be moved onto it.',
      'Browserbase setup: [personal account](/settings/account?tab=agents), '
        + '[organisation account](/settings/organization?tab=agents). '
        + 'Model plans: [Connected accounts](/settings/connections). '
        + 'A key saved only in Secrets is not a Browserbase connection.',
    ].join('\n'),
    toolName: 'account_connections_list',
  }
}
