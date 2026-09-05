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
import { detectSecrets, maskSecretValue, type AgentCardSpec } from '@nessie/schemas'
import { InfisicalVaultError, type InfisicalSecretNamespace } from './infisical-vault.js'
import {
  canManageSecretScope,
  findLockAboveScope,
  putSecretInVault,
  type VaultSecretWrite,
} from './secret-vault-write.js'
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

type VaultPlacement = {
  description: string | undefined
  key: string
  name: string
  provider: string | undefined
  redactMessageId: string | undefined
  scopeId: string
  scopeType: 'personal' | 'team' | 'project' | 'organization'
  /** Held only to scrub this exact string from the message it leaked into. */
  value: string
  written: VaultSecretWrite
}

type DashboardSourcePlacement = {
  actor: NonNullable<Awaited<ReturnType<typeof resolveDashboardActor>>>
  headerName: string | undefined
  key: string
  mode: 'bearer' | 'header'
  sourceId: string
  value: string
}

/** Mirrors the `{12,}` floor the scanner's assignment grammar already uses. */
const MIN_REDACTABLE_SECRET_LENGTH = 12

export type AgentCardSecretPlacements = {
  connector: ConnectorPlacement[]
  dashboardSource: DashboardSourcePlacement[]
  mcpAccess: Awaited<ReturnType<typeof resolveMcpUserAccess>> | null
  vault: VaultPlacement[]
}

/**
 * Drop vault material written while resolving a press that then failed to
 * commit. Callers run this on any error after resolution; without it a
 * rolled-back press would leave an unreachable value in the vault.
 */
export const rollbackAgentCardSecretPlacements = async (
  placements: AgentCardSecretPlacements,
): Promise<void> => {
  for (const placement of placements.vault) await placement.written.rollback()
}

export class AgentCardSecretPlacementError extends Error {
  constructor(
    readonly httpStatus: 403 | 409 | 502 | 503,
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
    isOwner: boolean
    organizationId: string
    secrets: Record<string, string>
    spec: AgentCardSpec
    userId: string
  },
): Promise<AgentCardSecretPlacements> => {
  let mcpAccess: Awaited<ReturnType<typeof resolveMcpUserAccess>> | null = null
  const connector: ConnectorPlacement[] = []
  const dashboardSource: DashboardSourcePlacement[] = []
  const vault: VaultPlacement[] = []
  try {

    for (const block of input.spec.blocks) {
      if (block.type !== 'secret') continue
      const value = input.secrets[block.key]
      if (value === undefined) continue

      if (block.destination.kind === 'vault_secret') {
        const destination = block.destination
        const scope = await canManageSecretScope({
          actorId: input.userId,
          isOwner: input.isOwner,
          organizationId: input.organizationId,
          prisma,
          ...(destination.scopeId === undefined ? {} : { scopeId: destination.scopeId }),
          scopeType: destination.scopeType,
        })
        if (!scope.allowed) {
          throw new AgentCardSecretPlacementError(
            403,
            'SECRET_SCOPE_DENIED',
            'You cannot manage secrets in this scope.',
          )
        }
        // The same refusal `POST /api/secrets` makes. A card is the other door
        // to one vault seam, so a lock a level above has to close both — an
        // agent asking for a personal STRIPE_API_KEY the organisation has
        // pinned would otherwise write a row the resolver never consults.
        const lock = await findLockAboveScope({
          actorId: input.userId,
          name: destination.name,
          organizationId: input.organizationId,
          prisma,
          scopeType: destination.scopeType,
        })
        if (lock) {
          throw new AgentCardSecretPlacementError(
            409,
            'SECRET_LOCKED_ABOVE',
            `"${destination.name}" is locked at the ${lock.scopeType} level and cannot be `
            + 'overridden here.',
          )
        }
        const namespace: InfisicalSecretNamespace = {
          organizationId: input.organizationId,
          scopeId: scope.scopeId,
          scopeType: destination.scopeType,
        }
        // The vault write cannot join the press transaction, so it happens here
        // and `rollbackAgentCardSecretPlacements` undoes it if the press loses
        // its claim. Resolving before the claim also means an instance with no
        // vault configured refuses while the card is still answerable.
        try {
          vault.push({
            description: destination.description,
            key: block.key,
            name: destination.name,
            provider: destination.provider,
            redactMessageId: destination.redactMessageId,
            scopeId: scope.scopeId,
            scopeType: destination.scopeType,
            value,
            written: await putSecretInVault({
              ...(destination.description === undefined
                ? {}
                : { description: destination.description }),
              namespace,
              value,
            }),
          })
        } catch (error) {
          if (error instanceof InfisicalVaultError) {
            throw new AgentCardSecretPlacementError(
              error.code === 'NOT_CONFIGURED' ? 503 : 502,
              error.code === 'NOT_CONFIGURED' ? 'SECRETS_NOT_CONFIGURED' : 'VAULT_UNAVAILABLE',
              error.message,
            )
          }
          throw error
        }
        continue
      }

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

    return { connector, dashboardSource, mcpAccess, vault }
  } catch (error) {
    // A card may carry several secret blocks, and a vault write already
    // happened for every one resolved before the refusal. Without this, a
    // second block denied for scope would strand the first block's value in
    // Infisical with no Nessie row: unreachable, unrotatable, undeletable.
    for (const placement of vault) await placement.written.rollback()
    throw error
  }
}

/** Store validated secrets inside the press transaction, then return safe facts only. */
export const storeAgentCardSecrets = async (
  tx: Prisma.TransactionClient,
  input: {
    dashboardCredentials: CredentialStore
    mcpSecretStore: SecretStore
    organizationId: string
    placements: AgentCardSecretPlacements
    threadId: string
    userId: string
  },
): Promise<Record<string, unknown>> => {
  const outcomes: Record<string, unknown> = {}

  for (const placement of input.placements.vault) {
    const secret = await tx.secret.create({
      data: {
        createdById: input.userId,
        ...(placement.description === undefined ? {} : { description: placement.description }),
        name: placement.name,
        organizationId: input.organizationId,
        ...(placement.provider === undefined ? {} : { provider: placement.provider }),
        reference: placement.written.reference,
        scopeId: placement.scopeId,
        scopeType: placement.scopeType,
        vaultReference: placement.written.vaultReference,
      },
      select: { id: true, reference: true },
    })
    // Take the credential back out of the conversation it leaked into. The
    // message is bounded to this card's own thread, and the replacement is
    // computed here — the exact value the person typed, masked to its
    // structural prefix, plus a scanner pass for anything alongside it. An
    // agent chooses the target, never the text.
    //
    // The length floor is what stops this being a defacement tool: the rewrite
    // replaces every occurrence of the submitted value, so a card naming
    // somebody else's message plus a presser who types a common word would
    // otherwise scribble over that message. Nothing shorter than the shortest
    // credential the scanner will match is worth scrubbing.
    let redactedMessageId: string | null = null
    if (placement.redactMessageId && placement.value.length >= MIN_REDACTABLE_SECRET_LENGTH) {
      const message = await tx.message.findFirst({
        select: { content: true, id: true },
        where: { id: placement.redactMessageId, threadId: input.threadId },
      })
      if (message?.content?.includes(placement.value)) {
        // Only the credential's own spans are rewritten. Running the scanner
        // across the whole message would let one press mangle unrelated text in
        // somebody else's message on a single false positive.
        const recognised = detectSecrets(placement.value)[0]
        const mask = recognised
          // A recognised credential keeps `sk_live_`, which is what makes the
          // replacement legible as "a Stripe key was here".
          ? maskSecretValue(placement.value, recognised.type)
          : maskSecretValue(placement.value, 'high_entropy_token', { revealPrefix: false })
        await tx.message.update({
          // `editedAt` is what tells every later render that this text is not
          // what its author wrote. A silent rewrite would be worse than the
          // leak it fixes.
          data: {
            content: message.content.split(placement.value).join(mask),
            editedAt: new Date(),
          },
          where: { id: message.id },
        })
        redactedMessageId = message.id
      }
    }

    // Safe facts only: a name and a reference the person can already see on
    // the Secrets screen. Never the value, and never the vault path.
    outcomes[placement.key] = {
      kind: 'vault_secret',
      name: placement.name,
      ...(redactedMessageId ? { redactedMessageId } : {}),
      reference: secret.reference,
      scopeType: placement.scopeType,
    }
  }

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
