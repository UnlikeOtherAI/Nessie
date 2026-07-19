import type { PrismaClient } from '@prisma/client'
import {
  McpTransportConfigSchema,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import { createInstance, type McpInstanceRow } from '@nessie/mcp-manage'
import {
  DEEPSIGNAL_MCP_CREDENTIAL_REF,
  DEEPSIGNAL_MCP_ORIGIN,
} from '@nessie/runtime'

import {
  ensureExternalAgentBootstrap,
  getExternalAgentProduct,
  type ExternalAgentProduct,
} from './external-agent.js'
import { upsertProductAccountLink } from './integrations.js'

/**
 * Per-user activation / deactivation of an external-agent product (§3 of the
 * DeepSignal integration plan). Three idempotent steps behind one button:
 * team-gate check → linked UOA identity → integration-managed user-scoped MCP
 * instance → conversation channel bootstrap. DeepSignal's static app key is a
 * deployment credential; it never enters the browser or per-user secret store.
 */

export const EXTERNAL_AGENT_ACTIVATION_ERROR_CODES = {
  UNKNOWN_PRODUCT: 'EXTERNAL_AGENT_UNKNOWN_PRODUCT',
  TEAM_CONTEXT_REQUIRED: 'EXTERNAL_AGENT_TEAM_CONTEXT_REQUIRED',
  TEAM_NOT_ENABLED: 'EXTERNAL_AGENT_TEAM_NOT_ENABLED',
  CATALOG_ENTRY_NOT_FOUND: 'EXTERNAL_AGENT_CATALOG_ENTRY_NOT_FOUND',
  CATALOG_CONTRACT_INVALID: 'EXTERNAL_AGENT_CATALOG_CONTRACT_INVALID',
  SSO_LINK_REQUIRED: 'EXTERNAL_AGENT_SSO_LINK_REQUIRED',
} as const

export type ExternalAgentActivationErrorCode =
  (typeof EXTERNAL_AGENT_ACTIVATION_ERROR_CODES)[keyof typeof EXTERNAL_AGENT_ACTIVATION_ERROR_CODES]

export class ExternalAgentActivationError extends Error {
  constructor(
    readonly code: ExternalAgentActivationErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ExternalAgentActivationError'
  }
}

export type ExternalAgentActivationContext = {
  actorContext: AuthorizedActionContext
  organizationId: string
  userId: string
  teamId: string | null
}

export type ExternalAgentActivationResult = {
  channelId: string
  instanceId: string
}

export type ExternalAgentDeactivationResult = {
  channelId: string | null
  instanceId: string | null
}

const resolveProduct = (productSlug: string): ExternalAgentProduct => {
  const product = getExternalAgentProduct(productSlug)
  if (!product) {
    throw new ExternalAgentActivationError(
      EXTERNAL_AGENT_ACTIVATION_ERROR_CODES.UNKNOWN_PRODUCT,
      `"${productSlug}" is not an external-agent product`,
    )
  }
  return product
}

const requireTeamId = (teamId: string | null): string => {
  if (!teamId) {
    throw new ExternalAgentActivationError(
      EXTERNAL_AGENT_ACTIVATION_ERROR_CODES.TEAM_CONTEXT_REQUIRED,
      'A team context is required to activate an external agent',
    )
  }
  return teamId
}

const assertTeamEnabled = async (
  prisma: PrismaClient,
  input: { organizationId: string; teamId: string; productSlug: string },
): Promise<void> => {
  const enablement = await prisma.productTeamEnablement.findUnique({
    where: {
      organizationId_teamId_productSlug: {
        organizationId: input.organizationId,
        teamId: input.teamId,
        productSlug: input.productSlug,
      },
    },
    select: { enabled: true },
  })
  if (!enablement?.enabled) {
    throw new ExternalAgentActivationError(
      EXTERNAL_AGENT_ACTIVATION_ERROR_CODES.TEAM_NOT_ENABLED,
      `${input.productSlug} is not enabled for your team`,
    )
  }
}

const assertLinkedSsoIdentity = async (
  prisma: PrismaClient,
  input: { organizationId: string; userId: string; productSlug: string },
): Promise<void> => {
  const link = await prisma.productAccountLink.findUnique({
    where: {
      organizationId_userId_productSlug: {
        organizationId: input.organizationId,
        userId: input.userId,
        productSlug: input.productSlug,
      },
    },
    select: {
      activeOrgId: true,
      activeTeamId: true,
      status: true,
      uoaSub: true,
    },
  })
  if (
    link?.status !== 'linked'
    || !link.uoaSub
    || !link.activeOrgId
    || !link.activeTeamId
  ) {
    throw new ExternalAgentActivationError(
      EXTERNAL_AGENT_ACTIVATION_ERROR_CODES.SSO_LINK_REQUIRED,
      'Sign in to Nessie with UnlikeOtherAI SSO and select an active organization/team first.',
    )
  }
}

type CatalogEntry = {
  id: string
  authMethod: string
  defaultTransportConfig: unknown
}

const loadFirstPartyCatalogEntry = async (
  prisma: PrismaClient,
  productSlug: string,
): Promise<CatalogEntry> => {
  const entry = await prisma.mcpCatalogEntry.findFirst({
    where: {
      name: productSlug,
      visibility: 'public',
      status: 'published',
      integratedProducts: { some: { slug: productSlug } },
    },
    select: { id: true, authMethod: true, defaultTransportConfig: true },
  })
  if (!entry) {
    throw new ExternalAgentActivationError(
      EXTERNAL_AGENT_ACTIVATION_ERROR_CODES.CATALOG_ENTRY_NOT_FOUND,
      `No published first-party catalog entry named "${productSlug}"`,
    )
  }
  if (entry.authMethod !== 'bearer') {
    throw new ExternalAgentActivationError(
      EXTERNAL_AGENT_ACTIVATION_ERROR_CODES.CATALOG_CONTRACT_INVALID,
      'The first-party DeepSignal connector is not configured for its product app key.',
    )
  }
  const transport = McpTransportConfigSchema.safeParse(
    entry.defaultTransportConfig,
  )
  if (
    !transport.success
    || transport.data.transport === 'stdio'
    || new URL(transport.data.url).origin !== DEEPSIGNAL_MCP_ORIGIN
  ) {
    throw new ExternalAgentActivationError(
      EXTERNAL_AGENT_ACTIVATION_ERROR_CODES.CATALOG_CONTRACT_INVALID,
      `The first-party DeepSignal connector must target ${DEEPSIGNAL_MCP_ORIGIN}.`,
    )
  }
  return entry
}

const ensureUserInstance = async (
  prisma: PrismaClient,
  ctx: ExternalAgentActivationContext,
  catalogEntryId: string,
): Promise<McpInstanceRow> => {
  const existing = await prisma.mcpServerInstance.findFirst({
    where: {
      organizationId: ctx.organizationId,
      catalogEntryId,
      scopeType: 'user',
      scopeId: ctx.userId,
    },
  })
  if (existing) {
    await prisma.mcpServerCredentialOverride.deleteMany({
      where: { instanceId: existing.id },
    })
    return prisma.mcpServerInstance.update({
      where: { id: existing.id },
      data: {
        credentialRef: DEEPSIGNAL_MCP_CREDENTIAL_REF,
        lifecycleState: 'active',
        transportConfig: {},
      },
    })
  }
  const created = await createInstance(prisma, ctx.actorContext, {
    catalogEntryId,
    credentialRef: DEEPSIGNAL_MCP_CREDENTIAL_REF,
    managedProvision: true,
    scopeType: 'user',
    scopeId: ctx.userId,
  })
  return prisma.mcpServerInstance.update({
    where: { id: created.id },
    data: {
      credentialRef: DEEPSIGNAL_MCP_CREDENTIAL_REF,
      lifecycleState: 'active',
      transportConfig: {},
    },
  })
}

export const activateExternalAgentProduct = async (
  prisma: PrismaClient,
  productSlug: string,
  ctx: ExternalAgentActivationContext,
): Promise<ExternalAgentActivationResult> => {
  const product = resolveProduct(productSlug)
  const teamId = requireTeamId(ctx.teamId)
  await assertTeamEnabled(prisma, {
    organizationId: ctx.organizationId,
    teamId,
    productSlug: product.slug,
  })
  await assertLinkedSsoIdentity(prisma, {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    productSlug: product.slug,
  })

  const catalogEntry = await loadFirstPartyCatalogEntry(prisma, product.slug)
  const instance = await ensureUserInstance(prisma, ctx, catalogEntry.id)

  await upsertProductAccountLink(prisma, {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    productSlug: product.slug,
    status: 'linked',
  })

  const bootstrap = await ensureExternalAgentBootstrap(prisma, {
    organizationId: ctx.organizationId,
    product,
    teamId,
    userId: ctx.userId,
  })

  return {
    channelId: bootstrap.channelId,
    instanceId: instance.id,
  }
}

export const deactivateExternalAgentProduct = async (
  prisma: PrismaClient,
  productSlug: string,
  ctx: Pick<ExternalAgentActivationContext, 'organizationId' | 'userId'>,
): Promise<ExternalAgentDeactivationResult> => {
  const product = resolveProduct(productSlug)

  const instance = await prisma.mcpServerInstance.findFirst({
    where: {
      organizationId: ctx.organizationId,
      scopeType: 'user',
      scopeId: ctx.userId,
      catalogEntry: {
        name: product.slug,
        visibility: 'public',
        integratedProducts: { some: { slug: product.slug } },
      },
    },
    select: { id: true },
  })
  if (instance) {
    // Registered tools cascade via the registry's mcpInstanceId FK (SetNull) —
    // sweep them explicitly so stale entries don't linger as orphans (mirrors
    // the PA `connector_uninstall` tool).
    await prisma.$transaction([
      prisma.toolRegistryEntry.deleteMany({ where: { mcpInstanceId: instance.id } }),
      prisma.mcpServerInstance.delete({ where: { id: instance.id } }),
    ])
  }

  await prisma.productAccountLink.updateMany({
    where: {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      productSlug: product.slug,
    },
    data: { status: 'revoked', lastVerifiedAt: new Date() },
  })

  const dmKey = `extagent:${product.slug}:${ctx.organizationId}:${ctx.userId}`
  const channel = await prisma.channel.findUnique({
    where: { dmKey },
    select: { id: true, archivedAt: true },
  })
  if (channel && !channel.archivedAt) {
    await prisma.channel.update({
      where: { id: channel.id },
      data: { archivedAt: new Date() },
    })
  }

  return {
    channelId: channel?.id ?? null,
    instanceId: instance?.id ?? null,
  }
}
