import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import {
  addDeepWaterIdentityHeaders,
  buildMcpToolset,
  isManagedDeepWaterCatalog,
  type McpToolPolicy,
} from './mcp-toolset.js'

/**
 * Scope-exposure rules for the MCP toolset: which instances' tools a given
 * run can see. Uses a mocked Prisma — no MCP traffic is exchanged (dispatch is
 * not invoked).
 */

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

const makePrisma = (rows: RowSeed[]): PrismaClient => {
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
      findUnique: async () => null,
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
  // A team-scoped, Ledger-backed DeepWater instance projects research_start flagged
  // requiresExplicitGrant: team scope alone must NOT expose it — only an
  // explicit per-agent allow does, for PA or shared agents alike.
  const rows: RowSeed[] = [
    {
      id: 'dw',
      toolName: 'research_start',
      scopeType: 'team',
      scopeId: 'team-1',
      requiresExplicitGrant: true,
    },
  ]
  // Default off: a shared agent in-team with no policy does NOT see it.
  assert.deepEqual(await exposedNames(rows, { agentKind: 'shared' }), [])
  // Default off: an in-team PA with no grant does NOT see it either.
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

test('managed DeepWater resolves only the shared service credential ref', async () => {
  const resolvedRefs: string[] = []
  const toolset = await buildMcpToolset(
    makePrisma([
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
    ]),
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
          return 'service-token'
        },
      },
    },
  )
  assert.deepEqual(resolvedRefs, ['LEDGER_PROXY_TOKEN'])
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

test('DeepWater keeps service auth and adds fresh required identity headers', async () => {
  const calls: unknown[] = []
  const transport = await addDeepWaterIdentityHeaders(
    {
      transport: 'http',
      url: 'https://ledger.unlikeotherai.com/v1/mcp/deepwater',
      headers: { Authorization: 'Bearer service-token', 'X-Existing': 'yes' },
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
      Authorization: 'Bearer service-token',
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
        headers: { Authorization: 'Bearer service-token' },
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
