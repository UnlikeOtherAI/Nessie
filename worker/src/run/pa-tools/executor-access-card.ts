import {
  EXECUTOR_ALLOW_ACCESS_CARD_ACTION_KEY, getExecutorAccessView, getExecutorForUser,
} from '@nessie/executor-manage'
import type { AuthorizedActionContext } from '@nessie/schemas'
import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import { postAgentCard } from './agent-card-post.js'

/** One explicit grant in the requesting person's chat, with its normal alert doorway. */
export const postExecutorAccessCard = async (
  context: BuiltinToolRuntimeContext,
  actor: AuthorizedActionContext,
  input: { accessChangeId: string; executorId: string; agentId: string; expiresAt: Date },
): Promise<void> => {
  const [machine, access, agent] = await Promise.all([
    getExecutorForUser(context.prisma, actor, input.executorId),
    getExecutorAccessView(context.prisma, actor, input.executorId),
    context.prisma.agent.findFirst({
      where: { id: input.agentId, organizationId: actor.tenant.organizationId }, select: { name: true },
    }),
  ])
  const revision = [...(access?.descriptorRevisions ?? [])].sort((a, b) => b.revision - a.revision)[0]
  if (!machine || !access?.canManage || !agent || !context.runContext || revision?.reviewStatus !== 'active') {
    throw new Error('Approve the machine’s current permissions before adding an agent.')
  }
  const facts = [
    `Allow **${agent.name}** to use **${machine.executor.label}** with its approved permissions.`,
    `Operations: ${revision.operationKeys.join(', ')}.`,
    revision.commandAllowlist?.length ? `Programs: ${revision.commandAllowlist.join(', ')}.` : null,
    revision.mcpServers?.length ? `Local apps: ${revision.mcpServers.join(', ')}.` : null,
    revision.codingSessions
      ? `Coding tools run as this machine’s user, with its files and logins. `
        + `Agents: ${revision.codingSessions.agents.join(', ')}. Folders: ${revision.codingSessions.rootNames.join(', ')}.`
      : null,
    'This access remains until you remove it. No additional verification code is needed.',
  ].filter((line): line is string => line !== null)
  await postAgentCard(context, context.runContext, {
    card: {
      schemaVersion: 1, title: `Allow ${agent.name} on ${machine.executor.label}`,
      blocks: [{ type: 'text', markdown: facts.join('\n\n') }],
      actions: [{ key: EXECUTOR_ALLOW_ACCESS_CARD_ACTION_KEY, label: 'Allow access', style: 'primary', submits: true }],
    },
    executorAccessChangeId: input.accessChangeId,
    expiresAt: input.expiresAt,
    respondentUserIds: [actor.actor.actorId],
  })
}
