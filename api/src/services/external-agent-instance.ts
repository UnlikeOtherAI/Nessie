import type { PrismaClient } from '@prisma/client'
import {
  resolveInstanceMcpTransport,
  type SecretResolver,
} from '@nessie/mcp-manage'
import type { McpTransportConfig } from '@nessie/schemas'

/**
 * Resolve the requesting user's user-scoped MCP instance for a first-party
 * product and return a ready-to-dispatch transport (auth header applied).
 *
 * This is the one place that turns "this user + this product slug" into a
 * transport: the user-scoped `McpServerInstance` whose catalog entry name is the
 * product slug, resolved through the shared `resolveInstanceMcpTransport` seam so
 * probe, the worker driver, history hydration, and the Signals surface can never
 * disagree about how a credential becomes a header. Returns `null` when the
 * connector is not installed, cannot be resolved, or an OAuth connector has not
 * finished sign-in yet — callers surface a fail-closed "needs setup" state
 * rather than fabricate data.
 */
export const resolveUserScopedProductTransport = async (
  prisma: PrismaClient,
  ctx: {
    organizationId: string
    userId: string
    slug: string
    channelId?: string | null
    managedCredentialRef?: string
  },
  secretResolver: SecretResolver,
): Promise<McpTransportConfig | null> => {
  const instance = await prisma.mcpServerInstance.findFirst({
    where: {
      organizationId: ctx.organizationId,
      scopeType: 'user',
      scopeId: ctx.userId,
      catalogEntry: {
        name: ctx.slug,
        visibility: 'public',
        ...(ctx.managedCredentialRef
          ? { integratedProducts: { some: { slug: ctx.slug } } }
          : {}),
      },
    },
    select: { credentialRef: true, id: true },
  })
  if (!instance) return null
  if (
    ctx.managedCredentialRef
    && instance.credentialRef !== ctx.managedCredentialRef
  ) {
    return null
  }

  const resolved = await resolveInstanceMcpTransport(
    prisma,
    instance.id,
    {
      userId: ctx.userId,
      organizationId: ctx.organizationId,
      ...(ctx.channelId ? { channelId: ctx.channelId } : {}),
    },
    secretResolver,
  )
  if (!resolved) return null
  if (
    ctx.managedCredentialRef
    && (resolved.authMethod !== 'bearer' || resolved.lifecycleState !== 'active')
  ) {
    return null
  }
  if (resolved.authMethod === 'oauth2' && resolved.lifecycleState !== 'active') {
    return null
  }
  return resolved.transport
}
