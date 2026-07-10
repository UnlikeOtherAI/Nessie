import {
  canManageInstanceScope,
  canStartOAuthForInstance,
  createCatalogEntry,
  createInstance,
  createPgOAuthStateStore,
  discoverMcpEndpoint,
  getCatalogEntry,
  listInstancesVisibleToUser,
  MCP_CATALOG_ERROR_CODES,
  McpCatalogError,
  McpInstanceError,
  McpOAuthError,
  resolveMcpUserAccess,
  searchMcpLibrary,
  startOAuth,
  storeInstanceSecret,
  testInstance,
  publishCatalogEntry,
  type CreateCatalogEntryInput,
  type McpInstanceRow,
  type McpLibraryEntry,
  type McpUserAccess,
} from '@nessie/mcp-manage'
import type { AuthorizedActionContext } from '@nessie/schemas'

import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { requireActingUserId } from './access.js'
import { formatSection, truncate } from './tool-output.js'

/**
 * Personal-assistant MCP connector management tools.
 *
 * The PA acts as its owner, so every operation here re-derives the acting
 * user's rights from the database via the same `@nessie/mcp-manage` helpers
 * the `/api/mcp/*` routes use: members self-serve at their own user scope,
 * owners/admins can additionally install at the shared scopes ("make this
 * available to the whole team/org"). Secrets provided in chat are written to
 * the encrypted secret store and never echoed back.
 */

type ConnectorToolContext = {
  actorContext: AuthorizedActionContext
  organizationId: string
  userId: string
  access: McpUserAccess
}

const buildConnectorContext = async (
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

const requireMcpSecrets = (context: BuiltinToolRuntimeContext) => {
  if (!context.mcpSecrets) {
    throw new Error(
      'Connector credential storage is not configured on this worker.',
    )
  }
  return context.mcpSecrets
}

const describeAuth = (authMethod: string, authHint: string | null): string => {
  if (authMethod === 'none') return 'no credential needed'
  const hint = authHint ? ` — ${authHint}` : ''
  if (authMethod === 'oauth2') {
    return `sign-in based (OAuth)${hint}`
  }
  return `requires a credential (${authMethod})${hint}`
}

const formatLibraryEntry = (entry: McpLibraryEntry): string =>
  [
    `- ${entry.label} (${entry.name}) [${entry.source}]`,
    `  url=${entry.url} transport=${entry.transport} | ${describeAuth(entry.authMethod, entry.authHint)}`,
    entry.description ? `  ${truncate(entry.description, 160)}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n')

const discoveredToolCount = (instance: McpInstanceRow): number =>
  Array.isArray(instance.discoveredTools) ? instance.discoveredTools.length : 0

const formatInstanceLine = (
  instance: McpInstanceRow,
  catalogLabel: string,
  authMethod: string | null,
): string => {
  const needsCredential =
    authMethod !== null
    && authMethod !== 'none'
    && !instance.credentialRef
    && instance.lifecycleState !== 'active'
  return [
    `- ${catalogLabel} | scope=${instance.scopeType} | state=${instance.lifecycleState}`
    + ` | tools=${discoveredToolCount(instance)} | instanceId=${instance.id}`,
    needsCredential ? '  needs a credential: ask the user, then call connector_set_secret' : null,
    instance.lastError ? `  last error: ${truncate(instance.lastError, 140)}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n')
}

const runTestAndDescribe = async (
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

// ─── connector_list ─────────────────────────────────────────────────────────

export const runConnectorListTool = async (
  context: BuiltinToolRuntimeContext,
): Promise<ToolExecutionResult> => {
  const ctx = await buildConnectorContext(context)
  const instances = await listInstancesVisibleToUser(
    context.prisma,
    ctx.organizationId,
    ctx.userId,
    ctx.access,
  )
  const catalogEntries = await context.prisma.mcpCatalogEntry.findMany({
    where: { id: { in: instances.map((i) => i.catalogEntryId) } },
    select: { id: true, label: true, authMethod: true },
  })
  const catalogById = new Map(catalogEntries.map((entry) => [entry.id, entry]))
  const lines = instances.map((instance) => {
    const entry = catalogById.get(instance.catalogEntryId)
    return formatInstanceLine(
      instance,
      entry?.label ?? 'Unknown connector',
      entry?.authMethod ?? null,
    )
  })
  return {
    inputSummary: '',
    outputPreview:
      formatSection(`Connectors (${lines.length})`, lines)
      || 'No connectors installed or shared with you yet. Use connector_library_search or connector_discover to add one.',
    toolName: 'connector_list',
  }
}

// ─── connector_library_search ───────────────────────────────────────────────

export const runConnectorLibrarySearchTool = async (
  context: BuiltinToolRuntimeContext,
  input: { query: string },
): Promise<ToolExecutionResult> => {
  const ctx = await buildConnectorContext(context)
  const query = input.query.trim()

  const catalogHits = await context.prisma.mcpCatalogEntry.findMany({
    where: {
      OR: [{ organizationId: ctx.organizationId }, { organizationId: null }],
      AND: [
        {
          OR: [
            { visibility: 'public', status: 'published' },
            { ownerUserId: ctx.userId },
          ],
        },
        {
          OR: [
            { name: { contains: query, mode: 'insensitive' } },
            { label: { contains: query, mode: 'insensitive' } },
            { description: { contains: query, mode: 'insensitive' } },
          ],
        },
      ],
    },
    select: {
      id: true,
      name: true,
      label: true,
      description: true,
      authMethod: true,
      locked: true,
    },
    take: 10,
  })
  const catalogLines = catalogHits.map((entry) =>
    [
      `- ${entry.label} (${entry.name}) [org catalog] catalogEntryId=${entry.id}`,
      entry.locked
        ? "  LOCKED by your organisation's admins — members cannot install this"
        : `  ${describeAuth(entry.authMethod, null)} | install with connector_install`,
    ].join('\n'),
  )

  const { entries, registryError } = await searchMcpLibrary(query)
  const libraryLines = entries.slice(0, 10).map(formatLibraryEntry)

  const sections = [
    formatSection(`Organisation catalog (${catalogLines.length})`, catalogLines),
    formatSection(`Public library (${libraryLines.length})`, libraryLines),
    registryError ? `Note: public registry search unavailable (${registryError}).` : '',
  ].filter((section) => section.length > 0)

  return {
    inputSummary: `query="${query}"`,
    outputPreview:
      sections.join('\n\n')
      || `No connectors found for "${query}". If the user has a URL, try connector_discover.`,
    toolName: 'connector_library_search',
  }
}

// ─── connector_discover ─────────────────────────────────────────────────────

export const runConnectorDiscoverTool = async (
  _context: BuiltinToolRuntimeContext,
  input: { url: string },
): Promise<ToolExecutionResult> => {
  const result = await discoverMcpEndpoint(input.url)
  const attemptLines = result.attempts.map(
    (attempt) =>
      `- ${attempt.url} (${attempt.transport}): ${attempt.outcome}`
      + (attempt.detail ? ` — ${truncate(attempt.detail, 120)}` : ''),
  )

  let summary: string
  if (result.proposal && result.proposal.authMethod === 'none') {
    summary =
      `Found a working MCP endpoint at ${result.proposal.url} `
      + `(transport=${result.proposal.transport}, no credential needed, `
      + `${result.proposal.toolNames.length} tool(s): `
      + `${result.proposal.toolNames.slice(0, 15).join(', ') || 'none listed'}). `
      + 'Install it with connector_install '
      + `(url=${result.proposal.url}, transport=${result.proposal.transport}, authMethod=none).`
  } else if (result.proposal) {
    summary =
      `Found an MCP endpoint at ${result.proposal.url} `
      + `(transport=${result.proposal.transport}) that requires credentials. `
      + `${result.proposal.note ?? ''} `
      + 'Install it with connector_install '
      + `(url=${result.proposal.url}, transport=${result.proposal.transport}, authMethod=bearer), `
      + 'then ask the user for their token and call connector_set_secret.'
  } else {
    summary =
      'No MCP endpoint found at that address. It may not host an MCP server, '
      + 'or it may live on a different path — try connector_library_search '
      + 'with the service name instead.'
  }

  return {
    inputSummary: `url="${input.url}"`,
    outputPreview: [summary, '', formatSection('Attempts', attemptLines)].join('\n').trim(),
    toolName: 'connector_discover',
  }
}

// ─── connector_install ──────────────────────────────────────────────────────

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

// ─── connector_authorize ────────────────────────────────────────────────────

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
    return { inputSummary, outputPreview: 'Connector instance not found.', toolName: 'connector_authorize' }
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

// ─── connector_test ─────────────────────────────────────────────────────────

const loadManageableInstance = async (
  context: BuiltinToolRuntimeContext,
  ctx: ConnectorToolContext,
  instanceId: string,
): Promise<{ instance: McpInstanceRow } | { error: string }> => {
  const instance = await context.prisma.mcpServerInstance.findFirst({
    where: { id: instanceId, organizationId: ctx.organizationId },
  })
  if (!instance) return { error: 'Connector instance not found.' }
  if (
    !canManageInstanceScope(ctx.access, ctx.userId, instance.scopeType, instance.scopeId)
  ) {
    return {
      error:
        'You can only manage your own connectors; this one is managed by the '
        + 'organisation owners/admins.',
    }
  }
  return { instance }
}

export const runConnectorTestTool = async (
  context: BuiltinToolRuntimeContext,
  input: { instanceId: string },
): Promise<ToolExecutionResult> => {
  const ctx = await buildConnectorContext(context)
  const loaded = await loadManageableInstance(context, ctx, input.instanceId)
  if ('error' in loaded) {
    return {
      inputSummary: `instanceId=${input.instanceId}`,
      outputPreview: loaded.error,
      toolName: 'connector_test',
    }
  }
  const summary = await runTestAndDescribe(context, ctx.organizationId, input.instanceId, ctx.userId)
  return {
    inputSummary: `instanceId=${input.instanceId}`,
    outputPreview: summary,
    toolName: 'connector_test',
  }
}

// ─── connector_set_secret ───────────────────────────────────────────────────

export const runConnectorSetSecretTool = async (
  context: BuiltinToolRuntimeContext,
  input: { instanceId: string; secret: string; shared?: boolean },
): Promise<ToolExecutionResult> => {
  const ctx = await buildConnectorContext(context)
  const secrets = requireMcpSecrets(context)
  const secretValue = input.secret.trim()
  // Never echo the credential back — the input summary is the instance id only.
  const inputSummary = `instanceId=${input.instanceId}`
  if (!secretValue) {
    return { inputSummary, outputPreview: 'No secret value provided.', toolName: 'connector_set_secret' }
  }

  const instance = await context.prisma.mcpServerInstance.findFirst({
    where: { id: input.instanceId, organizationId: ctx.organizationId },
  })
  if (!instance) {
    return { inputSummary, outputPreview: 'Connector instance not found.', toolName: 'connector_set_secret' }
  }

  const manageable = canManageInstanceScope(
    ctx.access,
    ctx.userId,
    instance.scopeType,
    instance.scopeId,
  )
  const { placement } = await storeInstanceSecret(context.prisma, secrets.store, {
    instance,
    userId: ctx.userId,
    access: ctx.access,
    secret: secretValue,
    shared: input.shared,
  })
  const where =
    placement === 'instance'
      ? 'as this connector\'s credential'
      : placement === 'shared_default'
        ? 'as the shared credential for everyone using this connector'
        : 'as your personal credential for this shared connector'

  const testSummary = manageable
    ? ` ${await runTestAndDescribe(context, ctx.organizationId, instance.id, ctx.userId)}`
    : ''
  return {
    inputSummary,
    outputPreview: `Credential stored securely ${where}.${testSummary}`,
    toolName: 'connector_set_secret',
  }
}

// ─── connector_uninstall ────────────────────────────────────────────────────

export const runConnectorUninstallTool = async (
  context: BuiltinToolRuntimeContext,
  input: { instanceId: string },
): Promise<ToolExecutionResult> => {
  const ctx = await buildConnectorContext(context)
  const loaded = await loadManageableInstance(context, ctx, input.instanceId)
  if ('error' in loaded) {
    return {
      inputSummary: `instanceId=${input.instanceId}`,
      outputPreview: loaded.error,
      toolName: 'connector_uninstall',
    }
  }
  // Registered tools cascade via the registry's mcpInstanceId FK (SetNull) —
  // sweep them explicitly so stale entries don't linger as orphans.
  await context.prisma.$transaction([
    context.prisma.toolRegistryEntry.deleteMany({
      where: { mcpInstanceId: loaded.instance.id },
    }),
    context.prisma.mcpServerInstance.delete({ where: { id: loaded.instance.id } }),
  ])
  return {
    inputSummary: `instanceId=${input.instanceId}`,
    outputPreview: 'Connector uninstalled and its registered tools removed.',
    toolName: 'connector_uninstall',
  }
}
