import {
  resolveInstanceMcpTransport,
  type SecretResolver,
} from '@nessie/mcp-manage'
import { DEEPSIGNAL_MCP_CREDENTIAL_REF } from '@nessie/runtime'
import type {
  McpTransportConfig,
  RunExecuteJobPayload,
} from '@nessie/schemas'

import { readConversationId } from './external-conversation-store.js'
import type { ExecutionDependencies, RunContext } from './execute/types.js'

const DEEPSIGNAL_SLUG = 'deepsignal'

export type ExternalTarget = {
  slug: string
  label: string
  instanceId: string
  transport: McpTransportConfig
  conversationId: string | null
  threadMetadata: unknown
}

export type ExternalTargetResolution =
  | { kind: 'ready'; target: ExternalTarget }
  | { kind: 'needs_setup'; slug: string; label: string; summary: string }

const effectiveUserIdOf = (payload: RunExecuteJobPayload): string | null =>
  payload.actorContext.actionContext.effectiveUserId
  ?? (payload.actorContext.actor.actorType === 'user'
    ? payload.actorContext.actor.actorId
    : null)

/** dmKey shape: `extagent:<slug>:<orgId>:<userId>`. */
const productSlugFromDmKey = (dmKey: string | null): string | null => {
  if (!dmKey) return null
  const parts = dmKey.split(':')
  return parts[0] === 'extagent' && parts[1] ? parts[1] : null
}

/**
 * Resolve a DM channel to its user-scoped connector and authenticated
 * transport. DeepSignal's first-party instance must use the deployment app
 * credential; generic third-party external agents keep their OAuth lifecycle.
 */
export const resolveExternalConversationTarget = async (
  deps: ExecutionDependencies,
  payload: RunExecuteJobPayload,
  context: RunContext,
  secretResolver: SecretResolver,
): Promise<ExternalTargetResolution | null> => {
  const channel = await deps.prisma.channel.findUnique({
    where: { id: context.channel.id },
    select: { dmKey: true, label: true },
  })
  const slug = productSlugFromDmKey(channel?.dmKey ?? null)
  if (!slug) {
    return null
  }
  const label = channel?.label?.trim() || slug
  const userId = effectiveUserIdOf(payload)
  if (!userId) {
    return { kind: 'needs_setup', slug, label, summary: 'No signed-in user for this conversation.' }
  }

  const instance = await deps.prisma.mcpServerInstance.findFirst({
    where: {
      organizationId: context.channel.organizationId,
      scopeType: 'user',
      scopeId: userId,
      catalogEntry: {
        name: slug,
        visibility: 'public',
        ...(slug === DEEPSIGNAL_SLUG
          ? { integratedProducts: { some: { slug: DEEPSIGNAL_SLUG } } }
          : {}),
      },
    },
    select: { credentialRef: true, id: true },
  })
  if (!instance) {
    return {
      kind: 'needs_setup',
      slug,
      label,
      summary: `${label} is not connected for your account yet. Activate it to start chatting.`,
    }
  }
  if (
    slug === DEEPSIGNAL_SLUG
    && instance.credentialRef !== DEEPSIGNAL_MCP_CREDENTIAL_REF
  ) {
    return {
      kind: 'needs_setup',
      slug,
      label,
      summary: `${label} is not connected with Nessie's product application key.`,
    }
  }

  const resolved = await resolveInstanceMcpTransport(
    deps.prisma,
    instance.id,
    {
      userId,
      channelId: context.channel.id,
      organizationId: context.channel.organizationId,
    },
    secretResolver,
  )
  if (!resolved) {
    return {
      kind: 'needs_setup',
      slug,
      label,
      summary: `${label} is not connected for your account yet. Activate it to start chatting.`,
    }
  }
  if (
    slug === DEEPSIGNAL_SLUG
    && (resolved.authMethod !== 'bearer' || resolved.lifecycleState !== 'active')
  ) {
    return {
      kind: 'needs_setup',
      slug,
      label,
      summary: `${label} is not connected with Nessie's product application key.`,
    }
  }
  if (resolved.authMethod === 'oauth2' && resolved.lifecycleState !== 'active') {
    return {
      kind: 'needs_setup',
      slug,
      label,
      summary: `Sign in to ${label} to finish connecting your account.`,
    }
  }

  const thread = await deps.prisma.thread.findUnique({
    where: { id: context.run.threadId },
    select: { metadata: true },
  })

  return {
    kind: 'ready',
    target: {
      slug,
      label,
      instanceId: instance.id,
      transport: resolved.transport,
      conversationId: readConversationId(thread?.metadata, slug),
      threadMetadata: thread?.metadata ?? null,
    },
  }
}
