import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { buildAuthorizedTransport } from '@nessie/mcp-manage'

import {
  ensureDeepWaterTeamInstance,
  LedgerDeepWaterActiveRunsError,
  NESSIE_LEDGER_APP_API_KEY_ENV,
  removeDeepWaterTeamInstance,
} from '../src/services/deepwater-activation.js'
import {
  asDeepWaterActivationPrisma as asPrisma,
  DEEP_WATER_CATALOG_ID,
  deepWaterOwnerContext as ownerContext,
  makeDeepWaterActivationFake as makeFake,
  type DeepWaterActiveRunFixture as ActiveRun,
} from './deepwater-activation-fixture.js'

/**
 * Team-scoped DeepWater activation: enabling for a team creates a team-scoped
 * tool-projecting instance with a usable HTTP transport (resolved from
 * LEDGER_DEEPWATER_MCP_URL) whose Ledger `research_*` tools land in
 * `ToolRegistryEntry` as active, explicit-grant rows; disabling removes it.
 * Uses an in-memory Prisma fake — no MCP traffic (tools come from the plugin
 * manifest, not a probe). The endpoint is an IP literal so the SSRF guard
 * passes without DNS.
 */

const DEEP_WATER_URL = 'https://8.8.8.8/v1/mcp/deepwater'
process.env.LEDGER_DEEPWATER_MCP_URL = DEEP_WATER_URL
process.env.LEDGER_PROXY_TOKEN = 'nessie-ledger-app-api-key'
process.env.UOA_DOMAIN = 'api.nessie.works'
process.env.UOA_CONFIG_URL = 'https://api.nessie.works/api/auth/sso/config'
process.env.UOA_CONFIG_JWT_KID = 'nessie-test'
process.env.UOA_CONFIG_JWT_PRIVATE_KEY_B64 = Buffer.from('private-key').toString('base64')
process.env.UOA_CLIENT_SECRET = 'uoa-client-secret'

test('enabling DeepWater creates a team-scoped instance with a usable transport and explicit-grant tools', async () => {
  const seed = { organizationId: randomUUID(), teamId: randomUUID() }
  const fake = makeFake(seed)

  const instance = await ensureDeepWaterTeamInstance(asPrisma(fake), ownerContext(seed.organizationId), seed)

  assert.ok(instance)
  assert.equal(fake.instances.length, 1)
  assert.equal(fake.instances[0]?.scopeType, 'team')
  assert.equal(fake.instances[0]?.scopeId, seed.teamId)
  assert.equal(fake.instances[0]?.lifecycleState, 'active')
  assert.equal(fake.instances[0]?.credentialRef, NESSIE_LEDGER_APP_API_KEY_ENV)

  // F2: the instance carries a resolvable HTTP transport, and a full transport
  // builds from catalog default + instance config with Nessie's dedicated,
  // product-bound Ledger app API key resolved as a bearer header.
  assert.deepEqual(fake.instances[0]?.transportConfig, { transport: 'http', url: DEEP_WATER_URL })
  const transport = buildAuthorizedTransport({
    catalogDefaultTransportConfig: { urlEnv: 'LEDGER_DEEPWATER_MCP_URL' },
    instanceTransportConfig: fake.instances[0]?.transportConfig,
    authConfig: { method: 'bearer' },
    secret: 'lk_test_proxy_token',
  })
  assert.equal(transport.transport, 'http')
  assert.equal((transport as { url: string }).url, DEEP_WATER_URL)
  assert.equal(
    transport.transport === 'http' ? transport.headers?.Authorization : null,
    'Bearer lk_test_proxy_token',
  )

  // The manifest's five Ledger tools carry useful schemas, are active, and
  // require an explicit per-agent grant.
  const toolNames = fake.registry.map((r) => r.toolId.split(':').pop())
  assert.deepEqual(toolNames.sort(), [
    'research_cancel',
    'research_list',
    'research_report',
    'research_start',
    'research_status',
  ])
  assert.deepEqual(
    (fake.registry.find((entry) => entry.toolId.endsWith(':research_start'))
      ?.inputSchema as { required?: string[] }).required,
    ['query'],
  )
  assert.equal(fake.registry.length, 5)
  assert.ok(fake.registry.every((r) => r.status === 'active'))
  assert.ok(fake.registry.every((r) =>
    (r.metadata as { requiresExplicitGrant?: boolean })?.requiresExplicitGrant === true))
  assert.ok(fake.registry.every((r) => r.mcpInstanceId === fake.instances[0]?.id))
})

test('enabling DeepWater twice is idempotent (no duplicate instance)', async () => {
  const seed = { organizationId: randomUUID(), teamId: randomUUID() }
  const fake = makeFake(seed)

  await ensureDeepWaterTeamInstance(asPrisma(fake), ownerContext(seed.organizationId), seed)
  await ensureDeepWaterTeamInstance(asPrisma(fake), ownerContext(seed.organizationId), seed)

  assert.equal(fake.instances.length, 1)
  assert.equal(fake.registry.length, 5)
})

test('re-enable preserves a current probe schema but enforces the Ledger app key', async () => {
  const seed = { organizationId: randomUUID(), teamId: randomUUID() }
  const instanceId = randomUUID()
  const probedSchema = { type: 'object', properties: { q: { type: 'string' } } }
  const ledgerTools = [
    'research_start',
    'research_status',
    'research_report',
    'research_list',
    'research_cancel',
  ]
  const fake = makeFake({
    ...seed,
    seedInstances: [
      {
        id: instanceId,
        organizationId: seed.organizationId,
        catalogEntryId: DEEP_WATER_CATALOG_ID,
        scopeType: 'team',
        scopeId: seed.teamId,
        credentialRef: 'legacy-direct-provider-key',
        lifecycleState: 'active',
        transportConfig: { transport: 'http', url: 'https://legacy.example.org/mcp' },
        discoveredTools: ledgerTools.map((name) => ({
          name,
          inputSchema: name === 'research_start' ? probedSchema : { type: 'object' },
        })),
      },
    ],
    seedRegistry: ledgerTools.map((name) => ({
        id: randomUUID(),
        organizationId: seed.organizationId,
        scopeKey: `mcp:${seed.organizationId}:team:${seed.teamId}`,
        toolId: `mcp:${instanceId}:${name}`,
        label: name,
        description: 'probed',
        inputSchema: name === 'research_start' ? probedSchema : { type: 'object' },
        outputSchema: null,
        status: 'active',
        metadata: {},
        mcpInstanceId: instanceId,
      })),
  })

  await ensureDeepWaterTeamInstance(asPrisma(fake), ownerContext(seed.organizationId), seed)

  // No manifest schema overwrites the current adapter probe, but routing and
  // auth are pinned to Ledger.
  assert.equal(fake.registry.length, 5)
  assert.deepEqual(
    fake.registry.find((entry) => entry.toolId.endsWith(':research_start'))?.inputSchema,
    probedSchema,
  )
  assert.deepEqual(fake.instances[0]?.transportConfig, {
    transport: 'http',
    url: DEEP_WATER_URL,
  })
  assert.equal(fake.instances[0]?.credentialRef, NESSIE_LEDGER_APP_API_KEY_ENV)
  assert.ok(fake.registry.every((entry) => entry.status === 'active'))
  assert.ok(fake.registry.every((entry) =>
    (entry.metadata as { requiresExplicitGrant?: boolean })?.requiresExplicitGrant === true))
})

test('re-enable replaces a legacy direct-provider tool contract', async () => {
  const seed = { organizationId: randomUUID(), teamId: randomUUID() }
  const instanceId = randomUUID()
  const fake = makeFake({
    ...seed,
    seedInstances: [
      {
        id: instanceId,
        organizationId: seed.organizationId,
        catalogEntryId: DEEP_WATER_CATALOG_ID,
        scopeType: 'team',
        scopeId: seed.teamId,
        credentialRef: 'legacy-oauth-secret',
        lifecycleState: 'active',
        transportConfig: { transport: 'http', url: 'https://legacy.example.org/mcp' },
        discoveredTools: [{ name: 'research_create', inputSchema: {} }],
      },
    ],
    seedRegistry: [
      {
        id: randomUUID(),
        organizationId: seed.organizationId,
        scopeKey: `mcp:${seed.organizationId}:team:${seed.teamId}`,
        toolId: `mcp:${instanceId}:research_create`,
        label: 'Create research',
        description: 'legacy',
        inputSchema: {},
        outputSchema: null,
        status: 'active',
        metadata: { requiresExplicitGrant: true },
        mcpInstanceId: instanceId,
      },
    ],
  })

  await ensureDeepWaterTeamInstance(asPrisma(fake), ownerContext(seed.organizationId), seed)

  assert.equal(fake.registry.some((entry) => entry.toolId.endsWith(':research_create')), false)
  assert.equal(fake.registry.length, 5)
  assert.equal(fake.instances[0]?.credentialRef, NESSIE_LEDGER_APP_API_KEY_ENV)
  assert.deepEqual(fake.instances[0]?.transportConfig, {
    transport: 'http',
    url: DEEP_WATER_URL,
  })
})

test('disabling DeepWater removes the instance and its projected tools', async () => {
  const seed = { organizationId: randomUUID(), teamId: randomUUID() }
  const fake = makeFake(seed)

  await ensureDeepWaterTeamInstance(asPrisma(fake), ownerContext(seed.organizationId), seed)
  const result = await removeDeepWaterTeamInstance(asPrisma(fake), seed)

  assert.ok(result.instanceId)
  assert.equal(fake.instances.length, 0)
  assert.equal(fake.registry.length, 0)
})

test('disabling DeepWater refuses to orphan an active research run', async () => {
  const seed = {
    activeRun: true,
    organizationId: randomUUID(),
    teamId: randomUUID(),
  }
  const fake = makeFake(seed)

  await ensureDeepWaterTeamInstance(
    asPrisma(fake),
    ownerContext(seed.organizationId),
    seed,
  )
  await assert.rejects(
    () => removeDeepWaterTeamInstance(asPrisma(fake), seed),
    LedgerDeepWaterActiveRunsError,
  )
  assert.equal(fake.instances.length, 1)
  assert.equal(fake.registry.length, 5)
})

test('disable cannot race a queued null-id dispatch into a billable orphan', async () => {
  const run: ActiveRun = {
    channelId: null,
    externalRunId: null,
    id: randomUUID(),
    result: {},
    status: 'queued',
    updatedAt: new Date(Date.now() - 16 * 60 * 1000),
  }
  const seed = {
    activeRuns: [run],
    organizationId: randomUUID(),
    teamId: randomUUID(),
  }
  const fake = makeFake(seed)

  await ensureDeepWaterTeamInstance(
    asPrisma(fake),
    ownerContext(seed.organizationId),
    seed,
  )
  await assert.rejects(
    () => removeDeepWaterTeamInstance(asPrisma(fake), seed),
    LedgerDeepWaterActiveRunsError,
  )

  assert.equal(run.status, 'queued')
  assert.equal(fake.instances.length, 1)
  assert.equal(fake.registry.length, 5)
})

test('setup-blocked and stale null-id running work remain conservative blockers', async () => {
  for (const status of ['needs_setup', 'running'] as const) {
    const run: ActiveRun = {
      channelId: randomUUID(),
      externalRunId: null,
      id: randomUUID(),
      result: {},
      status,
      updatedAt: new Date(0),
    }
    const seed = {
      activeRuns: [run],
      organizationId: randomUUID(),
      teamId: randomUUID(),
    }
    const fake = makeFake(seed)

    await ensureDeepWaterTeamInstance(
      asPrisma(fake),
      ownerContext(seed.organizationId),
      seed,
    )
    await assert.rejects(
      () => removeDeepWaterTeamInstance(asPrisma(fake), seed),
      LedgerDeepWaterActiveRunsError,
    )
    assert.equal(fake.instances.length, 1)
    assert.equal(run.status, status)
  }
})

test('disabling DeepWater never removes a private same-name connector', async () => {
  const seed = { organizationId: randomUUID(), teamId: randomUUID() }
  const fake = makeFake(seed)
  await ensureDeepWaterTeamInstance(asPrisma(fake), ownerContext(seed.organizationId), seed)

  const publicInstance = fake.instances[0]!
  const privateCatalogId = randomUUID()
  const privateInstanceId = randomUUID()
  fake.catalogEntries.unshift({
    ...fake.catalogEntries[0]!,
    id: privateCatalogId,
    integratedProductSlugs: [],
    visibility: 'private',
    ownerUserId: randomUUID(),
    organizationId: seed.organizationId,
  })
  fake.instances.unshift({
    ...publicInstance,
    id: privateInstanceId,
    catalogEntryId: privateCatalogId,
  })
  fake.registry.unshift(...fake.registry.map((entry) => ({
    ...entry,
    id: randomUUID(),
    toolId: entry.toolId.replace(publicInstance.id, privateInstanceId),
    mcpInstanceId: privateInstanceId,
  })))

  const result = await removeDeepWaterTeamInstance(asPrisma(fake), seed)

  assert.equal(result.instanceId, publicInstance.id)
  assert.deepEqual(fake.instances.map((row) => row.id), [privateInstanceId])
  assert.ok(fake.registry.every((row) => row.mcpInstanceId === privateInstanceId))
})
