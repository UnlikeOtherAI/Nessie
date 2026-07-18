import {
  canManageInstanceScope,
  canStartOAuthForInstance,
  createCatalogEntry,
  createInstance,
  createPgOAuthStateStore,
  getCatalogEntry,
  MCP_CATALOG_ERROR_CODES,
  McpCatalogError,
  McpInstanceError,
  McpOAuthError,
  publishCatalogEntry,
  startOAuth,
  type CreateCatalogEntryInput,
  type McpInstanceRow,
} from '@nessie/mcp-manage'

import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import {
  buildConnectorContext,
  describeAuth,
  runTestAndDescribe,
  type ConnectorToolContext,
} from './connector-runtime.js'
import { truncate } from './tool-output.js'

type InstallInput = {
  catalogEntryId?: string
  name?: string
  label?: string
  description?: string
  url?: string
  transport?: string
  authMethod?: string
  scope?: string
  scopeId?: string
}

const resolveInstallScope = (
  context: BuiltinToolRuntimeContext,
  ctx: ConnectorToolContext,
  input: InstallInput,
): { scopeType: 'user' | 'organization' | 'team' | 'channel'; scopeId: string } => {
  const scopeType = (input.scope ?? 'user') as 'user' | 'organization' | 'team' | 'channel'
  switch (scopeType) {
    case 'user':
      return { scopeType, scopeId: ctx.userId }
    case 'organization':
      return { scopeType, scopeId: ctx.organizationId }
    case 'team': {
      const teamId =
        input.scopeId
        ?? ctx.actorContext.tenant.teamId
        ?? ctx.actorContext.actionContext.teamId
        ?? null
      if (!teamId) throw new Error('No team in context — pass scopeId for team scope.')
      return { scopeType, scopeId: teamId }
    }
    case 'channel':
      return { scopeType, scopeId: input.scopeId ?? context.channel.id }
    default:
      throw new Error(`Unsupported install scope: ${String(scopeType)}`)
  }
}

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'connector'

const registerCatalogEntry = async (
  context: BuiltinToolRuntimeContext,
  ctx: ConnectorToolContext,
  input: InstallInput,
): Promise<{ id: string; label: string; authMethod: string }> => {
  if (!input.url || !input.transport) {
    throw new Error(
      'To register a new connector pass url + transport (+ name/label/authMethod), '
      + 'or pass catalogEntryId to install an existing one.',
    )
  }
  const transport = input.transport === 'sse' ? 'sse' : 'http'
  const authMethod =
    input.authMethod === 'bearer'
    || input.authMethod === 'api_key'
    || input.authMethod === 'oauth2'
      ? input.authMethod
      : 'none'
  const baseName = slugify(input.name ?? input.label ?? new URL(input.url).hostname)
  const entryInput: Omit<CreateCatalogEntryInput, 'name'> = {
    label: input.label ?? baseName,
    description: input.description ?? `Added by the personal assistant from ${input.url}`,
    protocol: transport,
    authMethod,
    authConfig:
      authMethod === 'api_key'
        ? { method: 'api_key', headerName: 'Authorization', valuePrefix: '' }
        : { method: authMethod },
    defaultTransportConfig: { transport, url: input.url },
    sourceUrl: input.url,
  }

  // The catalog name is unique per owner — retry with a numeric suffix instead
  // of failing the whole conversational flow on a duplicate.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const name = attempt === 0 ? baseName : `${baseName}-${attempt + 1}`
    try {
      const created = await createCatalogEntry(context.prisma, ctx.actorContext, {
        ...entryInput,
        name,
      })
      await publishCatalogEntry(context.prisma, ctx.actorContext, created.id)
      return { id: created.id, label: created.label, authMethod }
    } catch (error) {
      if (
        error instanceof McpCatalogError
        && error.code === MCP_CATALOG_ERROR_CODES.DUPLICATE_NAME
      ) {
        continue
      }
      throw error
    }
  }
  throw new Error(`Could not find a free catalog name for "${baseName}".`)
}

const mintAuthorizeUrl = async (
  context: BuiltinToolRuntimeContext,
  ctx: ConnectorToolContext,
  instanceId: string,
): Promise<string> => {
  const callbackUrl = context.mcpSecrets?.oauthCallbackUrl
  if (!callbackUrl) {
    throw new Error('OAuth is not configured on this worker (no public API URL).')
  }
  const result = await startOAuth({
    prisma: context.prisma,
    store: createPgOAuthStateStore(context.prisma),
    secretStore: context.mcpSecrets?.store,
    instanceId,
    actorContext: ctx.actorContext,
    callbackUrl,
  })
  return result.authorizationUrl
}

export const runConnectorInstallTool = async (
  context: BuiltinToolRuntimeContext,
  input: InstallInput,
): Promise<ToolExecutionResult> => {
  const ctx = await buildConnectorContext(context)
  const { scopeType, scopeId } = resolveInstallScope(context, ctx, input)

  if (!canManageInstanceScope(ctx.access, ctx.userId, scopeType, scopeId)) {
    return {
      inputSummary: `scope=${scopeType}`,
      outputPreview:
        `You can install connectors for yourself, but only organisation owners/admins `
        + `can install at the ${scopeType} scope. Install at your personal scope instead, `
        + 'or ask an admin to share it.',
      toolName: 'connector_install',
    }
  }

  let entry: { id: string; label: string; authMethod: string }
  if (input.catalogEntryId) {
    const existing = await getCatalogEntry(
      context.prisma,
      ctx.organizationId,
      input.catalogEntryId,
    )
    if (!existing) {
      return {
        inputSummary: `catalogEntryId=${input.catalogEntryId}`,
        outputPreview: 'Catalog entry not found. Use connector_library_search to find one.',
        toolName: 'connector_install',
      }
    }
    entry = { id: existing.id, label: existing.label, authMethod: existing.authMethod }
  } else {
    try {
      entry = await registerCatalogEntry(context, ctx, input)
    } catch (error) {
      if (error instanceof McpCatalogError) {
        return {
          inputSummary: `scope=${scopeType}`,
          outputPreview: error.message,
          toolName: 'connector_install',
        }
      }
      throw error
    }
  }

  let instance: McpInstanceRow
  try {
    instance = await createInstance(context.prisma, ctx.actorContext, {
      catalogEntryId: entry.id,
      scopeType,
      scopeId,
      // A URL passed alongside catalogEntryId becomes the instance endpoint
      // (some catalog entries — e.g. self-hosted servers — ship without one).
      ...(input.catalogEntryId && input.url
        ? {
            transportConfig: {
              transport: input.transport === 'sse' ? 'sse' : 'http',
              url: input.url,
            },
          }
        : {}),
    })
  } catch (error) {
    if (error instanceof McpInstanceError) {
      return {
        inputSummary: `label=${entry.label} scope=${scopeType}`,
        outputPreview: `Install failed: ${error.message}`,
        toolName: 'connector_install',
      }
    }
    throw error
  }

  let testSummary: string
  if (entry.authMethod === 'oauth2') {
    // Sign-in based: mint the authorization link right away so the user can
    // approve access in one step.
    try {
      const url = await mintAuthorizeUrl(context, ctx, instance.id)
      testSummary =
        'This connector uses OAuth sign-in. Share this link with the user to '
        + `open in their browser: ${url}\n`
        + 'When they confirm they have approved access, call connector_test '
        + `(instanceId=${instance.id}) to finish setup. The link expires in 10 minutes.`
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      testSummary =
        `This connector uses OAuth sign-in, but the flow could not be started: ${
          truncate(message, 200)
        } You can retry with connector_authorize (instanceId=${instance.id}).`
    }
  } else if (entry.authMethod !== 'none') {
    testSummary =
      `This connector ${describeAuth(entry.authMethod, null)}. Ask the user for their `
      + `API key or token, then call connector_set_secret (instanceId=${instance.id}).`
  } else {
    testSummary = await runTestAndDescribe(context, ctx.organizationId, instance.id, ctx.userId)
  }

  return {
    inputSummary: `label=${entry.label} scope=${scopeType}`,
    outputPreview:
      `Installed "${entry.label}" at ${scopeType} scope (instanceId=${instance.id}). `
      + testSummary,
    toolName: 'connector_install',
  }
}

export const runConnectorAuthorizeTool = async (
  context: BuiltinToolRuntimeContext,
  input: { instanceId: string },
): Promise<ToolExecutionResult> => {
  const ctx = await buildConnectorContext(context)
  const inputSummary = `instanceId=${input.instanceId}`
  const instance = await context.prisma.mcpServerInstance.findFirst({
    where: { id: input.instanceId, organizationId: ctx.organizationId },
  })
  if (!instance) {
    return {
      inputSummary,
      outputPreview: 'Connector instance not found.',
      toolName: 'connector_authorize',
    }
  }
  const allowed = await canStartOAuthForInstance(
    context.prisma,
    ctx.organizationId,
    ctx.userId,
    instance,
  )
  if (!allowed) {
    return {
      inputSummary,
      outputPreview: 'You do not have access to this connector.',
      toolName: 'connector_authorize',
    }
  }
  try {
    const url = await mintAuthorizeUrl(context, ctx, instance.id)
    return {
      inputSummary,
      outputPreview:
        'Share this sign-in link with the user (it is for them to open in '
        + `their browser): ${url}\n`
        + 'After they approve access, they should tell you — then call '
        + `connector_test (instanceId=${instance.id}) to finish setup. `
        + 'The link expires in 10 minutes.',
      toolName: 'connector_authorize',
    }
  } catch (error) {
    const message =
      error instanceof McpOAuthError || error instanceof Error
        ? error.message
        : String(error)
    return {
      inputSummary,
      outputPreview:
        `Could not start the sign-in flow: ${truncate(message, 240)} `
        + 'If the server expects an API key instead, ask the user for it and '
        + 'call connector_set_secret.',
      toolName: 'connector_authorize',
    }
  }
}
