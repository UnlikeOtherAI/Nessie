import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { DeepWaterHandoffInvariantError } from './deepwater-handoff-guard.js'
import {
  addDeepWaterIdentityHeaders,
  buildMcpToolset,
  isManagedDeepWaterCatalog,
  type McpToolPolicy,
} from './mcp-toolset.js'

type RowSeed = {
  catalogName?: string
  catalogVisibility?: string
  integratedProductSlugs?: string[]
  credentialRef?: string | null
  id: string
  toolName: string
  scopeType: string
  scopeId: string
  requiresExplicitGrant?: boolean
}

const makePrisma = (
  rows: RowSeed[],
  options: {
    credentialOverrideRef?: string
    onConnectorUsage?: () => void
    onCredentialOverrideLookup?: () => void
  } = {},
): PrismaClient => {
  return {
    toolRegistryEntry: {
      findMany: async () =>
        rows.map((row) => ({
          id: row.id,
          toolId: `mcp:inst-${row.id}:${row.toolName}`,
          label: row.toolName,
          description: '',
          inputSchema: { type: 'object' },
          transportConfig: {
            transport: 'mcp',
            serverId: `inst-${row.id}`,
            toolName: row.toolName,
          },
          metadata: row.requiresExplicitGrant ? { requiresExplicitGrant: true } : {},
          mcpInstanceId: `inst-${row.id}`,
          mcpInstance: {
            credentialRef: row.credentialRef ?? null,
            scopeType: row.scopeType,
            scopeId: row.scopeId,
            transportConfig: {},
            catalogEntry: {
              label: row.catalogName ?? 'Example',
              name: row.catalogName ?? 'example',
              visibility: row.catalogVisibility ?? 'private',
              integratedProducts: (row.integratedProductSlugs ?? []).map(
                (slug) => ({ slug }),
              ),
              authConfig: { method: 'none' },
              defaultTransportConfig: {
                transport: 'http',
                url: 'https://mcp.example.com/mcp',
              },
            },
          },
        })),
    },
    mcpServerInstance: {
      findUnique: async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        credentialRef: null,
      }),
    },
    mcpServerCredentialOverride: {
      findUnique: async () => {
        options.onCredentialOverrideLookup?.()
        return options.credentialOverrideRef
          ? { credentialRef: options.credentialOverrideRef }
          : null
      },
    },
    connectorUsageEvent: {
      create: async () => {
        options.onConnectorUsage?.()
        return {}
      },
    },
  } as unknown as PrismaClient
}

const actorContext = (overrides: {
  effectiveUserId?: string | null
  teamId?: string | null
  projectId?: string | null
} = {}): AuthorizedActionContext =>
  ({
    actor: { actorType: 'agent', actorId: 'agent-1', roles: [] },
    tenant: {
      organizationId: 'org-1',
      projectId: overrides.projectId ?? 'project-1',
      teamId: overrides.teamId ?? 'team-1',
    },
    actionContext: {
      effectiveUserId: overrides.effectiveUserId ?? 'user-1',
    },
  }) as unknown as AuthorizedActionContext

const exposedNames = async (
  rows: RowSeed[],
  options: {
    agentKind?: 'personal_assistant' | 'shared'
    toolPolicy?: McpToolPolicy
    effectiveUserId?: string | null
    channelId?: string
    teamId?: string | null
  } = {},
): Promise<string[]> => {
  const toolset = await buildMcpToolset(
    makePrisma(rows),
    'org-1',
    options.toolPolicy ?? null,
    actorContext({
      effectiveUserId: options.effectiveUserId,
      teamId: options.teamId,
    }),
    {
      agentId: 'agent-1',
      agentKind: options.agentKind ?? 'personal_assistant',
      channelId: options.channelId ?? 'channel-1',
    },
    { organizationId: 'org-1', actorId: 'agent-1' },
  )
  return toolset.entries.map((entry) => entry.originalToolName)
}

test('org-scope instances expose tools to every run in the org', async () => {
  const names = await exposedNames(
    [{ id: 'r1', toolName: 'org_tool', scopeType: 'organization', scopeId: 'org-1' }],
    { agentKind: 'shared' },
  )
  assert.deepEqual(names, ['org_tool'])
})

test('user-scope instances expose tools only to the installing user\'s PA runs', async () => {
  const rows: RowSeed[] = [
    { id: 'r1', toolName: 'my_tool', scopeType: 'user', scopeId: 'user-1' },
  ]
  assert.deepEqual(await exposedNames(rows, { agentKind: 'personal_assistant' }), ['my_tool'])
  // Another user's PA run: hidden.
  assert.deepEqual(
    await exposedNames(rows, { agentKind: 'personal_assistant', effectiveUserId: 'user-2' }),
    [],
  )
  // A shared agent run for the same user: hidden (channel members could drive it).
  assert.deepEqual(await exposedNames(rows, { agentKind: 'shared' }), [])
})

test('team and channel scopes follow the run context', async () => {
  const rows: RowSeed[] = [
    { id: 'r1', toolName: 'team_tool', scopeType: 'team', scopeId: 'team-1' },
    { id: 'r2', toolName: 'chan_tool', scopeType: 'channel', scopeId: 'channel-1' },
    { id: 'r3', toolName: 'other_team', scopeType: 'team', scopeId: 'team-9' },
    { id: 'r4', toolName: 'other_chan', scopeType: 'channel', scopeId: 'channel-9' },
  ]
  assert.deepEqual(await exposedNames(rows, { agentKind: 'shared' }), [
    'team_tool',
    'chan_tool',
  ])
})

test('explicit-grant DeepWater tools are OFF by default and need an explicit allow', async () => {
  const rows: RowSeed[] = [
    {
      id: 'dw',
      toolName: 'research_start',
      scopeType: 'team',
      scopeId: 'team-1',
      requiresExplicitGrant: true,
    },
  ]
  assert.deepEqual(await exposedNames(rows, { agentKind: 'shared' }), [])
  assert.deepEqual(await exposedNames(rows, { agentKind: 'personal_assistant' }), [])
  // Exposed ONLY with an explicit allow (shared agent).
  assert.deepEqual(
    await exposedNames(rows, { agentKind: 'shared', toolPolicy: { dw: true } }),
    ['research_start'],
  )
  // Exposed with an explicit allow (personal assistant) too.
  assert.deepEqual(
    await exposedNames(rows, { agentKind: 'personal_assistant', toolPolicy: { dw: true } }),
    ['research_start'],
  )
  // An explicit deny still hides it.
  assert.deepEqual(
    await exposedNames(rows, { agentKind: 'shared', toolPolicy: { dw: false } }),
    [],
  )
})

test('an explicit grant never lets a personal assistant cross a team boundary', async () => {
  const rows: RowSeed[] = [
    {
      id: 'dw',
      toolName: 'research_start',
      scopeType: 'team',
      scopeId: 'team-1',
      requiresExplicitGrant: true,
    },
  ]
  assert.deepEqual(
    await exposedNames(rows, {
      agentKind: 'personal_assistant',
      teamId: 'team-2',
      toolPolicy: { dw: true },
    }),
    [],
  )
})

test('managed DeepWater resolves only Nessie\'s product-bound Ledger app API key', async () => {
  const resolvedRefs: string[] = []
  let overrideLookups = 0
  const toolset = await buildMcpToolset(
    makePrisma(
      [
        {
          catalogName: 'deep-water',
          catalogVisibility: 'public',
          integratedProductSlugs: ['deep-water'],
          credentialRef: 'LEDGER_PROXY_TOKEN',
          id: 'dw',
          toolName: 'research_start',
          scopeType: 'team',
          scopeId: 'team-1',
          requiresExplicitGrant: true,
        },
      ],
      {
        credentialOverrideRef: 'direct-provider-user-key',
        onCredentialOverrideLookup: () => {
          overrideLookups += 1
        },
      },
    ),
    'org-1',
    { dw: true },
    actorContext(),
    {
      agentId: 'agent-1',
      agentKind: 'personal_assistant',
      channelId: 'channel-1',
    },
    {
      organizationId: 'org-1',
      teamId: 'team-1',
      userId: 'user-1',
      actorId: 'agent-1',
    },
    {
      secretResolver: {
        resolve: async (ref) => {
          resolvedRefs.push(ref)
          return 'nessie-ledger-app-api-key'
        },
      },
    },
  )
  assert.deepEqual(resolvedRefs, ['LEDGER_PROXY_TOKEN'])
  assert.equal(overrideLookups, 0)
  assert.deepEqual(
    toolset.entries.map((entry) => entry.originalToolName),
    ['research_start'],
  )
})

test('private same-name catalogs are not treated as managed DeepWater', () => {
  assert.equal(
    isManagedDeepWaterCatalog({
      integratedProducts: [],
      name: 'deep-water',
      visibility: 'private',
    }),
    false,
  )
  assert.equal(
    isManagedDeepWaterCatalog({
      integratedProducts: [{ slug: 'deep-water' }],
      name: 'deep-water',
      visibility: 'public',
    }),
    true,
  )
})

test('DeepWater keeps the product app key separate from signed caller identity', async () => {
  const calls: unknown[] = []
  const transport = await addDeepWaterIdentityHeaders(
    {
      transport: 'http',
      url: 'https://ledger.unlikeotherai.com/v1/mcp/deepwater',
      headers: {
        Authorization: 'Bearer nessie-ledger-app-api-key',
        'X-Existing': 'yes',
      },
    },
    {
      requestHeaders: async (input, options) => {
        calls.push({ input, options })
        return {
          'X-Nessie-Context': 'nessie-context',
          'X-UOA-Delegation': 'uoa-delegation',
        }
      },
    },
    {
      organizationId: 'org-1',
      teamId: 'team-1',
      userId: 'user-1',
      actorId: 'agent-1',
    },
    '00000000-0000-4000-8000-000000000004',
  )
  assert.deepEqual(calls, [{
    input: {
      organizationId: 'org-1',
      teamId: 'team-1',
      userId: 'user-1',
      actorId: 'agent-1',
    },
    options: {
      requireUoaIdentity: true,
      toolCallId: '00000000-0000-4000-8000-000000000004',
    },
  }])
  assert.deepEqual(
    transport.transport === 'http' ? transport.headers : null,
    {
      Authorization: 'Bearer nessie-ledger-app-api-key',
      'X-Existing': 'yes',
      'X-Nessie-Context': 'nessie-context',
      'X-UOA-Delegation': 'uoa-delegation',
    },
  )
})

test('DeepWater rejects dispatch identity without a stable provider tool-call id', async () => {
  await assert.rejects(
    addDeepWaterIdentityHeaders(
      {
        transport: 'http',
        url: 'https://ledger.unlikeotherai.com/v1/mcp/deepwater',
        headers: { Authorization: 'Bearer nessie-ledger-app-api-key' },
      },
      {
        requestHeaders: async () => ({}),
      },
      {
        organizationId: 'org-1',
        teamId: 'team-1',
        userId: 'user-1',
        agentId: 'agent-1',
        runId: 'run-1',
        actorId: 'agent-1',
      },
      '',
    ),
    /LEDGER_TOOL_CALL_ID_REQUIRED/,
  )
})

test('suppressed handoff calls do not record connector usage without a transport dispatch', async () => {
  let usageEvents = 0
  const toolset = await buildMcpToolset(
    makePrisma(
      [{
        catalogName: 'deep-water',
        catalogVisibility: 'public',
        integratedProductSlugs: ['deep-water'],
        id: 'dw',
        toolName: 'research_status',
        scopeType: 'team',
        scopeId: 'team-1',
        requiresExplicitGrant: true,
      }],
      { onConnectorUsage: () => { usageEvents += 1 } },
    ),
    'org-1',
    { dw: true },
    actorContext(),
    { agentId: 'agent-1', agentKind: 'personal_assistant', channelId: 'channel-1' },
    { organizationId: 'org-1', actorId: 'agent-1' },
    {
      deepWaterHandoffGuard: {
        assertCompletion: () => undefined,
        dispatchDeepWater: async () => ({
          deliveryToken: null,
          result: { output: 'suppressed', raw: null, success: false },
          transportInvoked: false,
        }),
        markDelivered: () => undefined,
        suppressBuiltin: async () => false,
        timeoutErrorFor: () => null,
      },
    },
  )

  const result = await toolset.dispatch('mcp_research_status', { id: 'rs_ticket' }, 'call-2')
  assert.equal(result.success, false)
  assert.equal(result.output, 'suppressed')
  assert.equal(usageEvents, 0)
})

test('pre-transport fatal handoff errors do not record connector usage', async () => {
  let usageEvents = 0
  const toolset = await buildMcpToolset(
    makePrisma(
      [{
        catalogName: 'deep-water',
        catalogVisibility: 'public',
        integratedProductSlugs: ['deep-water'],
        id: 'dw',
        toolName: 'research_start',
        scopeType: 'team',
        scopeId: 'team-1',
        requiresExplicitGrant: true,
      }],
      { onConnectorUsage: () => { usageEvents += 1 } },
    ),
    'org-1',
    { dw: true },
    actorContext(),
    { agentId: 'agent-1', agentKind: 'personal_assistant', channelId: 'channel-1' },
    { organizationId: 'org-1', actorId: 'agent-1' },
    {
      deepWaterHandoffGuard: {
        assertCompletion: () => undefined,
        dispatchDeepWater: async () => {
          throw new DeepWaterHandoffInvariantError('handoff-run-1')
        },
        markDelivered: () => undefined,
        suppressBuiltin: async () => false,
        timeoutErrorFor: () => null,
      },
    },
  )

  await assert.rejects(
    toolset.dispatch('mcp_research_start', { query: 'test' }, 'call-1'),
    DeepWaterHandoffInvariantError,
  )
  assert.equal(usageEvents, 0)
})

test('an explicit per-agent policy verdict overrides scope defaults both ways', async () => {
  const rows: RowSeed[] = [
    { id: 'allow-me', toolName: 'far_tool', scopeType: 'channel', scopeId: 'channel-9' },
    { id: 'deny-me', toolName: 'org_tool', scopeType: 'organization', scopeId: 'org-1' },
  ]
  const names = await exposedNames(rows, {
    agentKind: 'shared',
    toolPolicy: { 'allow-me': true, 'deny-me': false },
  })
  assert.deepEqual(names, ['far_tool'])
})

test('toolset picks deferred mode above the inline limit', async () => {
  const rows: RowSeed[] = Array.from({ length: 3 }, (_, i) => ({
    id: `r${i}`,
    toolName: `tool_${i}`,
    scopeType: 'organization',
    scopeId: 'org-1',
  }))
  const buildWith = async (inlineToolLimit: number) =>
    buildMcpToolset(
      makePrisma(rows),
      'org-1',
      null,
      actorContext({}),
      { agentId: 'agent-1', agentKind: 'shared', channelId: 'channel-1' },
      { organizationId: 'org-1', actorId: 'agent-1' },
      { inlineToolLimit },
    )
  const inline = await buildWith(10)
  assert.equal(inline.mode, 'inline')
  const inlineView = inline.createView()
  assert.equal(inlineView.descriptors.length, 3)

  const deferred = await buildWith(2)
  assert.equal(deferred.mode, 'deferred')
  const deferredView = deferred.createView()
  assert.deepEqual(
    deferredView.descriptors.map((d) => d.toolName),
    ['mcp_find_tools', 'mcp_load_tools', 'mcp_drop_tools'],
  )
  assert.ok(deferredView.handledNames.has('mcp_tool_0'))
})
