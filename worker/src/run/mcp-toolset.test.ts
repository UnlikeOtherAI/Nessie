import assert from 'node:assert/strict'
import test from 'node:test'

import { DeepWaterHandoffInvariantError } from './deepwater-handoff-guard.js'
import {
  addDeepWaterIdentityHeaders,
  buildMcpToolset,
  isManagedDeepWaterCatalog,
  type McpToolPolicy,
} from './mcp-toolset.js'
import {
  currentAllowedGrantFor,
  makeMcpPrisma,
  mcpActorContext,
  type RowSeed,
} from './mcp-toolset-fixtures.js'
import { createConsumedSourceSink } from './execute/disclosure-basis.js'

const exposedNames = async (
  rows: RowSeed[],
  options: {
    agentKind?: 'personal_assistant' | 'shared'
    toolPolicy?: McpToolPolicy
    effectiveUserId?: string | null
    channelId?: string
    isPersonalAssistantPresence?: boolean
    teamId?: string | null
    secretResolver?: { resolve(ref: string): Promise<string | null> }
  } = {},
): Promise<string[]> => {
  const toolset = await buildMcpToolset(
    makeMcpPrisma(rows),
    'org-1',
    options.toolPolicy ?? null,
    mcpActorContext({
      effectiveUserId: options.effectiveUserId,
      teamId: options.teamId,
    }),
    {
      agentId: 'agent-1',
      agentKind: options.agentKind ?? 'personal_assistant',
      channelId: options.channelId ?? 'channel-1',
      isPersonalAssistantPresence: options.isPersonalAssistantPresence,
    },
    { organizationId: 'org-1', actorId: 'agent-1' },
    { secretResolver: options.secretResolver ?? { resolve: async () => 'test-secret' } },
  )
  return toolset.entries.map((entry) => entry.originalToolName)
}

const withCurrentAllowedGrant = (row: RowSeed): RowSeed => ({
  ...row,
  grants: [currentAllowedGrantFor(row)],
})

test('org-scope instances expose tools to every run in the org', async () => {
  const names = await exposedNames(
    [{ id: 'r1', toolName: 'org_tool', scopeType: 'organization', scopeId: 'org-1' }],
    { agentKind: 'shared' },
  )
  assert.deepEqual(names, ['org_tool'])
})

test('a protected PA tool is denied without a ToolGrant', async () => {
  const row: RowSeed = {
    id: 'protected',
    requiresExplicitGrant: true,
    scopeId: 'org-1',
    scopeType: 'organization',
    toolName: 'protected_tool',
  }

  assert.deepEqual(await exposedNames([row]), [])
})

test('a protected PA tool admits only a matching allowed descriptor fingerprint grant', async () => {
  const row: RowSeed = {
    description: 'Read the current incident.',
    id: 'protected',
    inputSchema: { properties: { id: { type: 'string' } }, type: 'object' },
    outputSchema: { properties: { status: { type: 'string' } }, type: 'object' },
    requiresExplicitGrant: true,
    scopeId: 'org-1',
    scopeType: 'organization',
    toolName: 'protected_tool',
  }
  assert.deepEqual(await exposedNames([withCurrentAllowedGrant(row)]), ['protected_tool'])
})

test('a protected tool is denied when its descriptor fingerprint is stale', async () => {
  const grantedRow: RowSeed = {
    id: 'protected',
    outputSchema: { properties: { status: { type: 'string' } }, type: 'object' },
    requiresExplicitGrant: true,
    scopeId: 'org-1',
    scopeType: 'organization',
    toolName: 'protected_tool',
  }
  const row: RowSeed = {
    ...grantedRow,
    outputSchema: { properties: { status: { type: 'boolean' } }, type: 'object' },
    grants: [currentAllowedGrantFor(grantedRow)],
  }

  assert.deepEqual(await exposedNames([row]), [])
})

test('a shared agent cannot use a user-scope protected tool even with a matching grant', async () => {
  const row: RowSeed = {
    id: 'protected',
    requiresExplicitGrant: true,
    scopeId: 'user-1',
    scopeType: 'user',
    toolName: 'protected_tool',
  }
  assert.deepEqual(
    await exposedNames([withCurrentAllowedGrant(row)], { agentKind: 'shared' }),
    [],
  )
})

test('a PA presence can use its protected user-scope tool with a matching grant', async () => {
  const row: RowSeed = {
    id: 'protected',
    requiresExplicitGrant: true,
    scopeId: 'user-1',
    scopeType: 'user',
    toolName: 'protected_tool',
  }

  assert.deepEqual(
    await exposedNames([withCurrentAllowedGrant(row)], {
      isPersonalAssistantPresence: true,
    }),
    ['protected_tool'],
  )
})

test('a PA outside its personal presence cannot use a protected user-scope tool', async () => {
  const row: RowSeed = {
    id: 'protected',
    requiresExplicitGrant: true,
    scopeId: 'user-1',
    scopeType: 'user',
    toolName: 'protected_tool',
  }

  assert.deepEqual(
    await exposedNames([withCurrentAllowedGrant(row)], {
      isPersonalAssistantPresence: false,
    }),
    [],
  )
})

test('a protected tool ignores a role grant even when its fingerprint matches', async () => {
  const row: RowSeed = {
    id: 'protected',
    requiresExplicitGrant: true,
    scopeId: 'org-1',
    scopeType: 'organization',
    toolName: 'protected_tool',
  }

  assert.deepEqual(await exposedNames([{
    ...row,
    grants: [{ ...currentAllowedGrantFor(row), roleId: 'role-1' }],
  }]), [])
})

test('unprotected user-scope connections follow the effective user, with shared-agent policy still required', async () => {
  const rows: RowSeed[] = [
    {
      authConfig: { method: 'oauth2' },
      authMethod: 'oauth2',
      credentialRef: 'secret_user_1',
      id: 'r1',
      toolName: 'my_tool',
      scopeType: 'user',
      scopeId: 'user-1',
    },
  ]
  // The owner's PA has the in-scope default.
  assert.deepEqual(await exposedNames(rows, { agentKind: 'personal_assistant' }), ['my_tool'])
  // Another user's PA run: hidden.
  assert.deepEqual(
    await exposedNames(rows, { agentKind: 'personal_assistant', effectiveUserId: 'user-2' }),
    [],
  )
  // A shared agent run still needs its normal explicit tool grant.
  assert.deepEqual(await exposedNames(rows, { agentKind: 'shared' }), [])
  assert.deepEqual(
    await exposedNames(rows, { agentKind: 'shared', toolPolicy: { r1: true } }),
    ['my_tool'],
  )
  // That grant never carries user-1's OAuth connection into user-2's run.
  assert.deepEqual(
    await exposedNames(rows, {
      agentKind: 'shared',
      effectiveUserId: 'user-2',
      toolPolicy: { r1: true },
    }),
    [],
  )
})

test('an auth-requiring connection is hidden when its stored secret cannot resolve', async () => {
  const names = await exposedNames([
    {
      authConfig: { method: 'oauth2' },
      authMethod: 'oauth2',
      credentialRef: 'secret_stale',
      id: 'r1',
      scopeId: 'user-1',
      scopeType: 'user',
      toolName: 'calendar',
    },
  ], {
    secretResolver: { resolve: async () => null },
  })

  assert.deepEqual(names, [])
})

test('a shared OAuth connection is not advertised without the effective user\'s own credential', async () => {
  const rows: RowSeed[] = [{
    authConfig: { method: 'oauth2' },
    authMethod: 'oauth2',
    id: 'oauth',
    requiresExplicitGrant: true,
    scopeId: 'org-1',
    scopeType: 'organization',
    toolName: 'private_calendar',
  }]
  const grantedRows = rows.map(withCurrentAllowedGrant)
  const buildFor = (effectiveUserId: string) =>
    buildMcpToolset(
      makeMcpPrisma(grantedRows, {
        credentialOverrideRef: 'secret_user_1_oauth',
        credentialOverrideUserId: 'user-1',
      }),
      'org-1',
      { oauth: true },
      mcpActorContext({ effectiveUserId }),
      { agentId: 'agent-1', agentKind: 'shared', channelId: 'channel-1' },
      { organizationId: 'org-1', actorId: 'agent-1' },
      { secretResolver: { resolve: async () => 'test-secret' } },
    )

  assert.deepEqual(
    (await buildFor('user-1')).entries.map((entry) => entry.originalToolName),
    ['private_calendar'],
  )
  assert.deepEqual((await buildFor('user-2')).entries, [])
})

test('credential-backed MCP output records the user scope only for personal credentials', async () => {
  const dispatchMcpTool = async () => ({ output: 'private provider result', raw: null, success: true })
  const buildWith = async (row: RowSeed, options: {
    agentKind?: 'personal_assistant' | 'shared'
    credentialOverrideRef?: string
    credentialOverrideUserId?: string
    isPersonalAssistantPresence?: boolean
  } = {}) => {
    const consumedSources = createConsumedSourceSink()
    const toolset = await buildMcpToolset(
      makeMcpPrisma([row], options),
      'org-1',
      { [row.id]: true },
      mcpActorContext(),
      {
        agentId: 'agent-1',
        agentKind: options.agentKind ?? 'shared',
        channelId: 'channel-1',
        isPersonalAssistantPresence: options.isPersonalAssistantPresence,
      },
      { organizationId: 'org-1', actorId: 'agent-1' },
      {
        consumedSources,
        dispatchMcpTool,
        secretResolver: { resolve: async () => 'test-secret' },
      },
    )
    const entry = toolset.entries[0]
    assert.ok(entry)
    // A delegate view calls the same dispatch closure as the main loop.
    await toolset.createView().dispatch(entry.exposedName, {})
    return consumedSources.list()
  }

  const oauth = { authConfig: { method: 'oauth2' }, authMethod: 'oauth2' as const }
  assert.deepEqual(
    await buildWith(withCurrentAllowedGrant({
      ...oauth,
      credentialRef: 'secret_user_scope',
      id: 'user-scope',
      requiresExplicitGrant: true,
      scopeId: 'user-1',
      scopeType: 'user',
      toolName: 'personal_drive',
    }), { agentKind: 'personal_assistant', isPersonalAssistantPresence: true }),
    [{ scopeId: 'user-1', scopeType: 'user' }],
  )
  assert.deepEqual(
    await buildWith(
      withCurrentAllowedGrant({
        ...oauth,
        id: 'user-override',
        requiresExplicitGrant: true,
        scopeId: 'org-1',
        scopeType: 'organization',
        toolName: 'personal_calendar',
      }),
      { credentialOverrideRef: 'secret_user_override', credentialOverrideUserId: 'user-1' },
    ),
    [{ scopeId: 'user-1', scopeType: 'user' }],
  )
  assert.deepEqual(
    await buildWith(withCurrentAllowedGrant({
      authConfig: { headerName: 'X-API-Key', method: 'api_key', valuePrefix: '' },
      authMethod: 'api_key',
      credentialRef: 'secret_explicitly_shared',
      id: 'shared-key',
      requiresExplicitGrant: true,
      scopeId: 'org-1',
      scopeType: 'organization',
      toolName: 'shared_search',
    })),
    [],
  )
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

test('managed DeepWater tools require a current ToolGrant for every agent kind', async () => {
  const rows: RowSeed[] = [withCurrentAllowedGrant({
    catalogName: 'deep-water',
    catalogVisibility: 'public',
    credentialRef: 'LEDGER_PROXY_TOKEN',
    id: 'dw',
    integratedProductSlugs: ['deep-water'],
    toolName: 'research_start',
    scopeType: 'team',
    scopeId: 'team-1',
    requiresExplicitGrant: true,
  })]
  assert.deepEqual(await exposedNames(rows, { agentKind: 'shared' }), ['research_start'])
  assert.deepEqual(await exposedNames(rows, { agentKind: 'personal_assistant' }), ['research_start'])
})

test('an explicit grant never lets a personal assistant cross a team boundary', async () => {
  const rows: RowSeed[] = [withCurrentAllowedGrant({
    id: 'dw',
    toolName: 'research_start',
    scopeType: 'team',
    scopeId: 'team-1',
    requiresExplicitGrant: true,
  })]
  assert.deepEqual(
    await exposedNames(rows, {
      agentKind: 'personal_assistant',
      teamId: 'team-2',
    }),
    [],
  )
})

test('managed DeepWater resolves only Nessie\'s product-bound Ledger app API key', async () => {
  const resolvedRefs: string[] = []
  let overrideLookups = 0
  const deepWater = withCurrentAllowedGrant({
    catalogName: 'deep-water',
    catalogVisibility: 'public',
    integratedProductSlugs: ['deep-water'],
    credentialRef: 'LEDGER_PROXY_TOKEN',
    id: 'dw',
    toolName: 'research_start',
    scopeType: 'team',
    scopeId: 'team-1',
    requiresExplicitGrant: true,
  })
  const toolset = await buildMcpToolset(
    makeMcpPrisma(
      [deepWater],
      {
        credentialOverrideRef: 'direct-provider-user-key',
        onCredentialOverrideLookup: () => {
          overrideLookups += 1
        },
      },
    ),
    'org-1',
    null,
    mcpActorContext(),
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
  const deepWater = withCurrentAllowedGrant({
    catalogName: 'deep-water',
    catalogVisibility: 'public',
    integratedProductSlugs: ['deep-water'],
    id: 'dw',
    toolName: 'research_status',
    scopeType: 'team',
    scopeId: 'team-1',
    requiresExplicitGrant: true,
  })
  const toolset = await buildMcpToolset(
    makeMcpPrisma(
      [deepWater],
      { onConnectorUsage: () => { usageEvents += 1 } },
    ),
    'org-1',
    null,
    mcpActorContext(),
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
  const deepWater = withCurrentAllowedGrant({
    catalogName: 'deep-water',
    catalogVisibility: 'public',
    integratedProductSlugs: ['deep-water'],
    id: 'dw',
    toolName: 'research_start',
    scopeType: 'team',
    scopeId: 'team-1',
    requiresExplicitGrant: true,
  })
  const toolset = await buildMcpToolset(
    makeMcpPrisma(
      [deepWater],
      { onConnectorUsage: () => { usageEvents += 1 } },
    ),
    'org-1',
    null,
    mcpActorContext(),
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

test('explicit per-agent policy narrows exposure; an allow never lifts the install-scope ceiling', async () => {
  const rows: RowSeed[] = [
    { id: 'allow-me', toolName: 'far_tool', scopeType: 'channel', scopeId: 'channel-9' },
    { id: 'deny-me', toolName: 'org_tool', scopeType: 'organization', scopeId: 'org-1' },
  ]
  // Explicit allow CANNOT broaden exposure past install scope (channel-9 is
  // not this run's channel), while explicit deny still narrows it.
  const names = await exposedNames(rows, {
    agentKind: 'shared',
    toolPolicy: { 'allow-me': true, 'deny-me': false },
  })
  assert.deepEqual(names, [])
  // In scope, the explicit allow exposes the channel tool.
  const inScope = await exposedNames(rows, {
    agentKind: 'shared',
    channelId: 'channel-9',
    toolPolicy: { 'allow-me': true, 'deny-me': false },
  })
  assert.deepEqual(inScope, ['far_tool'])
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
      makeMcpPrisma(rows),
      'org-1',
      null,
      mcpActorContext(),
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
