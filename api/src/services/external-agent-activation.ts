import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import { createInstance, type McpInstanceRow } from '@nessie/mcp-manage'

import {
  ensureExternalAgentBootstrap,
  getExternalAgentProduct,
  type ExternalAgentProduct,
} from './external-agent.js'
import { upsertProductAccountLink } from './integrations.js'

/**
 * Per-user activation / deactivation of an external-agent product (§3 of the
 * DeepSignal integration plan). Three idempotent steps behind one button:
 * team-gate check → user-scoped MCP instance (+ OAuth sign-in) → conversation
 * channel bootstrap. Keyed by product slug so a second external agent is a data
 * change, not a code fork.
 */

export const EXTERNAL_AGENT_ACTIVATION_ERROR_CODES = {
  UNKNOWN_PRODUCT: 'EXTERNAL_AGENT_UNKNOWN_PRODUCT',
  TEAM_CONTEXT_REQUIRED: 'EXTERNAL_AGENT_TEAM_CONTEXT_REQUIRED',
  TEAM_NOT_ENABLED: 'EXTERNAL_AGENT_TEAM_NOT_ENABLED',
  CATALOG_ENTRY_NOT_FOUND: 'EXTERNAL_AGENT_CATALOG_ENTRY_NOT_FOUND',
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
  /**
   * Begin the MCP OAuth handshake for the user-scoped instance and return the
   * provider authorization URL. Injected so the orchestration stays free of the
   * HTTP/network layer; the route wires it to `@nessie/mcp-manage` `startOAuth`
   * with the encrypted secret store, pg-backed state, and shared callback URL.
   */
  startInstanceOAuth: (instanceId: string) => Promise<string>
}

export type ExternalAgentActivationResult = {
  channelId: string
  instanceId: string
  authorizeUrl?: string
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

type CatalogEntry = { id: string; authMethod: string }

const loadFirstPartyCatalogEntry = async (
  prisma: PrismaClient,
  productSlug: string,
): Promise<CatalogEntry> => {
  const entry = await prisma.mcpCatalogEntry.findFirst({
    where: { name: productSlug, visibility: 'public', status: 'published' },
    select: { id: true, authMethod: true },
  })
  if (!entry) {
    throw new ExternalAgentActivationError(
      EXTERNAL_AGENT_ACTIVATION_ERROR_CODES.CATALOG_ENTRY_NOT_FOUND,
      `No published first-party catalog entry named "${productSlug}"`,
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
    return existing
  }
  return createInstance(prisma, ctx.actorContext, {
    catalogEntryId,
    scopeType: 'user',
    scopeId: ctx.userId,
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

  const catalogEntry = await loadFirstPartyCatalogEntry(prisma, product.slug)
  const instance = await ensureUserInstance(prisma, ctx, catalogEntry.id)

  // Dynamic OAuth: a fresh instance is `pending_setup` until the user signs in.
  // Surface the authorize link and record the link as `needs_auth`; an already
  // active instance (token in place) is `linked`.
  const needsAuth =
    catalogEntry.authMethod === 'oauth2' && instance.lifecycleState !== 'active'
  let authorizeUrl: string | undefined
  if (needsAuth) {
    authorizeUrl = await ctx.startInstanceOAuth(instance.id)
  }

  await upsertProductAccountLink(prisma, {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    productSlug: product.slug,
    status: needsAuth ? 'needs_auth' : 'linked',
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
    ...(authorizeUrl ? { authorizeUrl } : {}),
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
      catalogEntry: { name: product.slug, visibility: 'public' },
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
