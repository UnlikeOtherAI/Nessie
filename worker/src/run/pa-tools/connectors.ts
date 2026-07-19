import {
  canManageInstanceScope,
  discoverMcpEndpoint,
  listInstancesVisibleToUser,
  isManagedDeepWaterInstance,
  searchMcpLibrary,
  storeInstanceSecret,
  type McpInstanceRow,
  type McpLibraryEntry,
} from '@nessie/mcp-manage'

import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import {
  buildConnectorContext,
  describeAuth,
  requireMcpSecrets,
  runTestAndDescribe,
  type ConnectorToolContext,
} from './connector-runtime.js'
import { formatSection, truncate } from './tool-output.js'

export {
  runConnectorAuthorizeTool,
  runConnectorInstallTool,
} from './connector-provisioning.js'

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
  if (
    await isManagedDeepWaterInstance(
      context.prisma,
      ctx.organizationId,
      loaded.instance.id,
    )
  ) {
    return {
      inputSummary: `instanceId=${input.instanceId}`,
      outputPreview:
        'DeepWater is provisioned and monitored by the Integrations service. '
        + 'Its connection requires signed per-user identity, so use a granted '
        + 'DeepWater research tool to verify access instead of probing it here.',
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
  if (
    await isManagedDeepWaterInstance(
      context.prisma,
      ctx.organizationId,
      instance.id,
    )
  ) {
    return {
      inputSummary,
      outputPreview:
        'DeepWater uses your signed UnlikeOtherAI SSO identity and Nessie\'s '
        + 'dedicated Ledger app API key; no personal secret is accepted.',
      toolName: 'connector_set_secret',
    }
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
  if (
    await isManagedDeepWaterInstance(
      context.prisma,
      ctx.organizationId,
      loaded.instance.id,
    )
  ) {
    return {
      inputSummary: `instanceId=${input.instanceId}`,
      outputPreview:
        'DeepWater lifecycle is managed from Integrations. '
        + 'Use the team enablement toggle to disable it.',
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
