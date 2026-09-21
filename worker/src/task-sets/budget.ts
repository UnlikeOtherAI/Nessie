import { admitRunToBudget } from '@nessie/runtime'
import { AuthorizedActionContextSchema } from '@nessie/schemas'
import type { ExecutionDependencies } from '../run/execute/types.js'
import { resolveRunBackstop } from '../run/run-budget.js'
import type { TaskSetClaim } from './processor.js'
import { TaskSetBlocked } from './state.js'

export const checkTaskSetBudget = async (
  deps: ExecutionDependencies, claim: TaskSetClaim, organizationPays: boolean,
): Promise<void> => {
  const limits = resolveRunBackstop()
  const usage = await deps.prisma.tokenLedgerEvent.aggregate({
    where: { runId: claim.attempt.runId }, _sum: { totalTokens: true, estimatedCostAmount: true },
  })
  if ((usage._sum.totalTokens ?? 0) >= limits.maxTokens
    || (usage._sum.estimatedCostAmount?.toNumber() ?? 0) * 100 >= limits.maxCostCents
    || Date.now() - claim.attempt.createdAt.getTime() >= limits.maxWallclockMs) {
    throw new TaskSetBlocked('processor_run_budget_reached')
  }
  if (!organizationPays) return
  const actor = AuthorizedActionContextSchema.parse(claim.set.launchOrigin)
  const verdict = await admitRunToBudget(deps.prisma, actor.tenant, {
    isHuman: false, runId: claim.attempt.runId,
    estimate: { tokens: limits.maxTokens, costUsd: limits.maxCostCents / 100 },
  })
  // A task set pins its processor. A degrade rule must ask for a new selection,
  // never silently switch this work to a different model or billing account.
  if (verdict.decision.action !== 'allow') throw new TaskSetBlocked('processor_budget_blocked')
}
