/**
 * Global agents — the app-provided tier, instantiated per organisation.
 *
 * The implementation lives in `@nessie/team-admin` because both the API
 * (bootstrap at login/provisioning) and the worker (blueprint lookup at run
 * start, `createAgentTrigger`'s refusal) need it, and `api/src/services/*` is
 * unreachable from the worker. This file is the thin re-export established
 * API callers import, exactly as the other shared services do.
 */
import type { PrismaClient } from '@prisma/client'
import { ensureGlobalAgentsForUser } from '@nessie/team-admin'

/**
 * Bootstrap every registered global agent for one person, best-effort.
 *
 * It runs beside `ensurePersonalAssistantBootstrap` at login and provisioning.
 * The Personal Assistant's own bootstrap is allowed to fail a login because the
 * PA is the product's spine; a global agent is not, and a blueprint problem
 * must never lock somebody out of their team. Failures are reported, and
 * the next login retries — the ensure path is idempotent by construction.
 */
export const attemptGlobalAgentsBootstrap = async (
  prisma: PrismaClient,
  input: { organizationId: string; teamId: string; userId: string },
  onError: (error: unknown) => void,
): Promise<void> => {
  try {
    await ensureGlobalAgentsForUser(prisma, input)
  } catch (error) {
    onError(error)
  }
}

export {
  AGENT_DESIGNER_BLUEPRINT,
  AGENT_DESIGNER_SLUG,
  DASHBOARD_DESIGNER_BLUEPRINT,
  DASHBOARD_DESIGNER_SLUG,
  ensureGlobalAgent,
  ensureGlobalAgentBinding,
  ensureGlobalAgentBootstrap,
  ensureGlobalAgentChannel,
  ensureGlobalAgentsForUser,
  ensureGlobalAgentSystemTeam,
  getGlobalAgentBlueprint,
  globalAgentHomeDmKey,
  listGlobalAgentBlueprints,
  resolveGlobalAgentModel,
  type GlobalAgentBlueprint,
  type GlobalAgentBootstrapInput,
  type GlobalAgentBootstrapResult,
} from '@nessie/team-admin'
