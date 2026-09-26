import type { FastifyBaseLogger } from 'fastify'
import { setExecutorAgentAccess } from '@nessie/executor-manage'
import type { AuthorizedActionContext } from '@nessie/schemas'
import { applyExecutorAccessChangeEffects } from '@nessie/team-admin'

import { notifyExecutorLeaseChanges } from './executor-leases.js'
import { notifyExecutorStatus } from './executor-status-events.js'
import type { RouteDeps } from './types.js'

/**
 * Assign an agent to a computer, or take it away, and tell every open screen.
 *
 * One sequence behind both doorways — the computer's own Agents tab
 * (`PUT /api/executors/:id/agents`) and the one grant write every account and
 * computer shares (`PUT /api/accounts/computer:<id>/agents/:agentId`) — so the
 * assignment, its operation grants, the agent's logical tool policy, the
 * conversation leases it ends and the status events it publishes can never
 * differ between them. It applies at once, as the sharing standard says: an
 * agent assignment takes no approval, password or emailed code.
 */
export const applyExecutorAgentAccessChange = async (
  deps: RouteDeps,
  log: FastifyBaseLogger,
  actor: AuthorizedActionContext,
  input: { agentId: string; executorId: string; state: 'allowed' | 'denied' },
): Promise<void> => {
  const changed = await setExecutorAgentAccess(deps.prisma, actor, input, (tx) =>
    applyExecutorAccessChangeEffects(tx, {
      actorContext: actor,
      change: { agentId: input.agentId, kind: 'agent_executor_access', state: input.state },
      executorId: input.executorId,
      ledgerSigningConfigured: false,
    }))
  await notifyExecutorLeaseChanges(deps, log, changed.endedLeases)
  await notifyExecutorStatus(deps, log, input.executorId, actor.tenant.organizationId)
}
