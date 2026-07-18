import {
  resolveMcpUserAccess,
  testInstance,
  type McpUserAccess,
} from '@nessie/mcp-manage'
import type { AuthorizedActionContext } from '@nessie/schemas'

import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import { requireActingUserId } from './access.js'
import { truncate } from './tool-output.js'

export type ConnectorToolContext = {
  actorContext: AuthorizedActionContext
  organizationId: string
  userId: string
  access: McpUserAccess
}

export const buildConnectorContext = async (
  context: BuiltinToolRuntimeContext,
): Promise<ConnectorToolContext> => {
  const userId = requireActingUserId(context)
  const organizationId = context.channel.organizationId
  const access = await resolveMcpUserAccess(context.prisma, organizationId, userId)
  return {
    // Catalog/instance writes must be attributed to the acting USER (FKs point
    // at the users table), not the assistant agent actor executing the run.
    actorContext: {
      ...context.actorContext,
      actor: { ...context.actorContext.actor, actorType: 'user', actorId: userId },
    },
    organizationId,
    userId,
    access,
  }
}

export const requireMcpSecrets = (context: BuiltinToolRuntimeContext) => {
  if (!context.mcpSecrets) {
    throw new Error(
      'Connector credential storage is not configured on this worker.',
    )
  }
  return context.mcpSecrets
}

export const describeAuth = (authMethod: string, authHint: string | null): string => {
  if (authMethod === 'none') return 'no credential needed'
  const hint = authHint ? ` — ${authHint}` : ''
  if (authMethod === 'oauth2') {
    return `sign-in based (OAuth)${hint}`
  }
  return `requires a credential (${authMethod})${hint}`
}

export const runTestAndDescribe = async (
  context: BuiltinToolRuntimeContext,
  organizationId: string,
  instanceId: string,
  probeUserId?: string,
): Promise<string> => {
  try {
    const tested = await testInstance(context.prisma, organizationId, instanceId, {
      secretResolver: context.mcpSecrets?.resolver,
      probeUserId,
    })
    const tools = Array.isArray(tested.discoveredTools)
      ? (tested.discoveredTools as Array<{ name?: string }>)
          .map((tool) => tool?.name)
          .filter((name): name is string => typeof name === 'string')
      : []
    const toolList = tools.length > 0 ? ` Tools: ${tools.slice(0, 20).join(', ')}` : ''
    return `Connection OK — ${tools.length} tool(s) discovered and registered.${toolList}`
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `Connection test failed: ${truncate(message, 300)}. `
      + 'If this server needs a credential, ask the user for their API key or '
      + 'token and call connector_set_secret.'
  }
}
