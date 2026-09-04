/**
 * Credential destinations for an agent-card press.
 *
 * The card route owns the one claim/message transaction. This service owns the
 * two destination-specific authorization mirrors, so adding a new destination
 * cannot turn the route into a chain of unrelated credential workflows.
 */

import type { Prisma, PrismaClient } from '@prisma/client'
import {
  canManageInstanceScope,
  getCatalogEntry,
  getInstance,
  isManagedIntegrationInstance,
  listInstancesVisibleToUser,
  resolveMcpUserAccess,
  storeInstanceSecret,
  type SecretStore,
} from '@nessie/mcp-manage'
import type { AgentCardSpec } from '@nessie/schemas'
import {
  createDashboardMembership,
  resolveDashboardActor,
  setSourceCredential,
  type CredentialStore,
} from '@nessie/dashboard'

type ConnectorPlacement = {
  authConfig: unknown
  authMethod: string
  instance: NonNullable<Awaited<ReturnType<typeof getInstance>>>
  key: string
  shared: boolean | undefined
  value: string
}

type DashboardSourcePlacement = {
  actor: NonNullable<Awaited<ReturnType<typeof resolveDashboardActor>>>
  headerName: string | undefined
  key: string
  mode: 'bearer' | 'header'
  sourceId: string
  value: string
}

export type AgentCardSecretPlacements = {
  connector: ConnectorPlacement[]
  dashboardSource: DashboardSourcePlacement[]
  mcpAccess: Awaited<ReturnType<typeof resolveMcpUserAccess>> | null
}

export class AgentCardSecretPlacementError extends Error {
  constructor(
    readonly httpStatus: 403 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'AgentCardSecretPlacementError'
  }
}

/**
 * Resolve every destination while the card is still open. A refusal happens
 * before its conditional claim, so a person can correct access or reconnect a
 * source without losing the form they just completed.
 */
export const resolveAgentCardSecretPlacements = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    secrets: Record<string, string>
    spec: AgentCardSpec
    userId: string
  },
): Promise<AgentCardSecretPlacements> => {
  let mcpAccess: Awaited<ReturnType<typeof resolveMcpUserAccess>> | null = null
  const connector: ConnectorPlacement[] = []
  const dashboardSource: DashboardSourcePlacement[] = []

  for (const block of input.spec.blocks) {
    if (block.type !== 'secret') continue
    const value = input.secrets[block.key]
    if (value === undefined) continue

    if (block.destination.kind === 'dashboard_source_credential') {
      const actor = await resolveDashboardActor(prisma, {
        organizationId: input.organizationId,
        userId: input.userId,
      })
      if (!actor) {
        throw new AgentCardSecretPlacementError(
          403,
          'CARD_SECRET_REFUSED',
          'Your membership is no longer active in this organisation.',
        )
      }
      const source = await prisma.dashboardDataSource.findFirst({
        select: { id: true },
        where: {
          archivedAt: null,
          id: block.destination.sourceId,
          organizationId: input.organizationId,
        },
      })
      if (!source) {
        throw new AgentCardSecretPlacementError(
          409,
          'CARD_SECRET_REFUSED',
          'That dashboard source no longer exists.',
        )
      }
      dashboardSource.push({
        actor,
        headerName: block.destination.headerName,
        key: block.key,
        mode: block.destination.mode,
        sourceId: source.id,
        value,
      })
      continue
    }

    const instance = await getInstance(
      prisma,
      input.organizationId,
      block.destination.instanceId,
    )
    if (!instance) {
      throw new AgentCardSecretPlacementError(
        409,
        'CARD_SECRET_REFUSED',
        'That connector no longer exists.',
      )
    }
    if (await isManagedIntegrationInstance(prisma, input.organizationId, instance.id)) {
      throw new AgentCardSecretPlacementError(
        409,
        'INTEGRATION_MANAGED_CREDENTIAL',
        'This first-party connector manages its own credentials.',
      )
    }
    const access = await resolveMcpUserAccess(prisma, input.organizationId, input.userId)
    mcpAccess = access
    const manageable = canManageInstanceScope(
      access,
      input.userId,
      instance.scopeType,
      instance.scopeId,
    )
    if (!manageable) {
      const visible = await listInstancesVisibleToUser(prisma, input.organizationId, input.userId)
      if (!visible.some((row) => row.id === instance.id)) {
        throw new AgentCardSecretPlacementError(
          403,
          'CARD_SECRET_REFUSED',
          'You do not have access to that connector.',
        )
      }
    }
    const catalogEntry = await getCatalogEntry(prisma, input.organizationId, instance.catalogEntryId)
    if (!catalogEntry) {
      throw new AgentCardSecretPlacementError(
        409,
        'CARD_SECRET_REFUSED',
        'That connector is not set up.',
      )
    }
    connector.push({
      authConfig: catalogEntry.authConfig,
      authMethod: catalogEntry.authMethod,
      instance,
      key: block.key,
      shared: block.destination.shared,
      value,
    })
  }

  return { connector, dashboardSource, mcpAccess }
}

/** Store validated secrets inside the press transaction, then return safe facts only. */
export const storeAgentCardSecrets = async (
  tx: Prisma.TransactionClient,
  input: {
    dashboardCredentials: CredentialStore
    mcpSecretStore: SecretStore
    placements: AgentCardSecretPlacements
    userId: string
  },
): Promise<Record<string, unknown>> => {
  const outcomes: Record<string, unknown> = {}

  for (const placement of input.placements.connector) {
    const stored = await storeInstanceSecret(tx, input.mcpSecretStore, {
      access: input.placements.mcpAccess ?? { role: null },
      authConfig: placement.authConfig,
      authMethod: placement.authMethod,
      instance: placement.instance,
      secret: placement.value,
      ...(placement.shared === undefined ? {} : { shared: placement.shared }),
      userId: input.userId,
    })
    outcomes[placement.key] = {
      instanceId: placement.instance.id,
      kind: 'connector_credential',
      placement: stored.placement,
    }
  }

  for (const placement of input.placements.dashboardSource) {
    await setSourceCredential(
      {
        actor: placement.actor,
        membership: createDashboardMembership(tx),
        prisma: tx,
      },
      {
        sourceId: placement.sourceId,
        mode: placement.mode,
        ...(placement.headerName ? { headerName: placement.headerName } : {}),
        plaintext: placement.value,
      },
      input.dashboardCredentials,
    )
    outcomes[placement.key] = {
      kind: 'dashboard_source_credential',
      sourceId: placement.sourceId,
    }
  }

  return outcomes
}
