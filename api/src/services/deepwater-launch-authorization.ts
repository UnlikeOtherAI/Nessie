import type { Prisma, PrismaClient } from '@prisma/client'

import {
  acquireAgentToolPolicyLock,
  normalizeToolPolicy,
} from './agent-tool-policy.js'
import {
  DEEP_WATER_PRODUCT_SLUG,
  runWithDeepWaterTransitionLock,
} from './deepwater-activation.js'
import { loadDeepWaterPolicyKeys } from './deepwater-agent-access.js'

export const DEEP_WATER_LAUNCH_AUTHORIZATION_ERROR_CODES = {
  ACCESS_REQUIRED: 'DEEP_WATER_PERSONAL_ASSISTANT_ACCESS_REQUIRED',
  MCP_INACTIVE: 'DEEP_WATER_MCP_INACTIVE',
  TEAM_DISABLED: 'DEEP_WATER_TEAM_DISABLED',
} as const

export class DeepWaterLaunchAuthorizationError extends Error {
  override readonly name = 'DeepWaterLaunchAuthorizationError'

  constructor(public readonly code: string, message: string) {
    super(message)
  }
}

/**
 * Linearize the launch boundary with both mutable authorities, in one lock
 * order everywhere: team transition first, then the Personal Assistant policy.
 * The final enabled/connector/6-of-6 reads and the caller's run insert all
 * happen inside the same transaction.
 */
export const runWithAuthorizedDeepWaterLaunch = <T>(
  prisma: PrismaClient,
  input: {
    organizationId: string
    teamId: string
  },
  action: (
    tx: Prisma.TransactionClient,
    connectorId: string,
  ) => Promise<T>,
): Promise<T> =>
  runWithDeepWaterTransitionLock(prisma, input, async (tx) => {
    const enablement = await tx.productTeamEnablement.findUnique({
      where: {
        organizationId_teamId_productSlug: {
          organizationId: input.organizationId,
          productSlug: DEEP_WATER_PRODUCT_SLUG,
          teamId: input.teamId,
        },
      },
      select: { enabled: true },
    })
    if (!enablement?.enabled) {
      throw new DeepWaterLaunchAuthorizationError(
        DEEP_WATER_LAUNCH_AUTHORIZATION_ERROR_CODES.TEAM_DISABLED,
        'Deep Water is not enabled for this team',
      )
    }

    const instance = await tx.mcpServerInstance.findFirst({
      where: {
        organizationId: input.organizationId,
        scopeId: input.teamId,
        scopeType: 'team',
        lifecycleState: 'active',
        catalogEntry: {
          name: DEEP_WATER_PRODUCT_SLUG,
          organizationId: null,
          visibility: 'public',
          integratedProducts: {
            some: { slug: DEEP_WATER_PRODUCT_SLUG },
          },
        },
      },
      select: { id: true },
    })
    if (!instance) {
      throw new DeepWaterLaunchAuthorizationError(
        DEEP_WATER_LAUNCH_AUTHORIZATION_ERROR_CODES.MCP_INACTIVE,
        'Deep Water MCP is not active for this team',
      )
    }

    const personalAssistant = await tx.agent.findFirst({
      where: {
        agentKind: 'personal_assistant',
        organizationId: input.organizationId,
        systemManaged: true,
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    })
    if (!personalAssistant) {
      throw new DeepWaterLaunchAuthorizationError(
        DEEP_WATER_LAUNCH_AUTHORIZATION_ERROR_CODES.ACCESS_REQUIRED,
        'Grant all six Deep Water tools to the Personal Assistant before launching research.',
      )
    }

    await acquireAgentToolPolicyLock(tx, personalAssistant.id)
    const [access, agent] = await Promise.all([
      loadDeepWaterPolicyKeys(tx, input),
      tx.agent.findUnique({
        where: { id: personalAssistant.id },
        select: { toolPolicy: true },
      }),
    ])
    const policy = normalizeToolPolicy(agent?.toolPolicy)
    if (
      !access.configured
      || !access.policyKeys.every((policyKey) => policy[policyKey] === true)
    ) {
      throw new DeepWaterLaunchAuthorizationError(
        DEEP_WATER_LAUNCH_AUTHORIZATION_ERROR_CODES.ACCESS_REQUIRED,
        'Grant all six Deep Water tools to the Personal Assistant before launching research.',
      )
    }

    return action(tx, instance.id)
  })
