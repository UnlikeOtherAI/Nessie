import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import type { AuthorizedActionContext } from '@nessie/schemas'

import {
  activateExternalAgentProduct,
  deactivateExternalAgentProduct,
  ExternalAgentActivationError,
  type ExternalAgentActivationContext,
} from '../src/services/external-agent-activation.js'
import {
  asPrisma,
  makeExternalAgentPrismaFake,
} from './helpers/external-agent-prisma-fake.js'

const buildSeed = () => ({
  organizationId: randomUUID(),
  projectId: randomUUID(),
  teamId: randomUUID(),
})

const actorContextFor = (
  organizationId: string,
  userId: string,
): AuthorizedActionContext =>
  ({
    tenant: { organizationId },
    actor: { actorId: userId, actorType: 'user' },
    actionContext: { requestId: 'activation-request' },
  }) as unknown as AuthorizedActionContext

const buildCtx = (
  seed: { organizationId: string; teamId: string },
  userId: string,
): ExternalAgentActivationContext => ({
  actorContext: actorContextFor(seed.organizationId, userId),
  organizationId: seed.organizationId,
  userId,
  teamId: seed.teamId,
})

const linkedAccount = (
  seed: { organizationId: string },
  userId: string,
) => ({
  activeOrgId: 'uoa-org',
  activeTeamId: 'uoa-team',
  organizationId: seed.organizationId,
  productSlug: 'deepsignal',
  status: 'linked',
  uoaSub: 'uoa-user',
  userId,
})

test('activation rejects an unknown external-agent product', async () => {
  const seed = buildSeed()
  const fake = makeExternalAgentPrismaFake(seed)
  await assert.rejects(
    activateExternalAgentProduct(
      asPrisma(fake),
      'not-a-product',
      buildCtx(seed, randomUUID()),
    ),
    (error: unknown) =>
      error instanceof ExternalAgentActivationError
      && error.code === 'EXTERNAL_AGENT_UNKNOWN_PRODUCT',
  )
})

test('activation is blocked before provisioning when the team is disabled', async () => {
  const seed = buildSeed()
  const userId = randomUUID()
  const fake = makeExternalAgentPrismaFake({
    ...seed,
    accountLinks: [linkedAccount(seed, userId)],
  })

  await assert.rejects(
    activateExternalAgentProduct(
      asPrisma(fake),
      'deepsignal',
      buildCtx(seed, userId),
    ),
    (error: unknown) =>
      error instanceof ExternalAgentActivationError
      && error.code === 'EXTERNAL_AGENT_TEAM_NOT_ENABLED',
  )
  assert.equal(fake.channelsById.size, 0)
  assert.equal(fake.instances.length, 0)
})

test('activation requires a currently linked UOA subject and active workspace', async () => {
  const seed = buildSeed()
  const userId = randomUUID()
  const fake = makeExternalAgentPrismaFake({
    ...seed,
    accountLinks: [{
      ...linkedAccount(seed, userId),
      status: 'revoked',
    }],
    teamEnablements: [{
      teamId: seed.teamId,
      productSlug: 'deepsignal',
      enabled: true,
    }],
  })

  await assert.rejects(
    activateExternalAgentProduct(
      asPrisma(fake),
      'deepsignal',
      buildCtx(seed, userId),
    ),
    (error: unknown) =>
      error instanceof ExternalAgentActivationError
      && error.code === 'EXTERNAL_AGENT_SSO_LINK_REQUIRED',
  )
  assert.equal(fake.channelsById.size, 0)
})

test('activation rejects the obsolete per-user OAuth catalog contract', async () => {
  const seed = buildSeed()
  const userId = randomUUID()
  const fake = makeExternalAgentPrismaFake({
    ...seed,
    accountLinks: [linkedAccount(seed, userId)],
    catalogEntries: [{
      authMethod: 'oauth2',
      defaultTransportConfig: {
        transport: 'http',
        url: 'https://api.deepsignal.live/mcp',
      },
      id: randomUUID(),
      integratedProductSlugs: ['deepsignal'],
      name: 'deepsignal',
      status: 'published',
      visibility: 'public',
    }],
    teamEnablements: [{
      teamId: seed.teamId,
      productSlug: 'deepsignal',
      enabled: true,
    }],
  })

  await assert.rejects(
    activateExternalAgentProduct(
      asPrisma(fake),
      'deepsignal',
      buildCtx(seed, userId),
    ),
    (error: unknown) =>
      error instanceof ExternalAgentActivationError
      && error.code === 'EXTERNAL_AGENT_CATALOG_CONTRACT_INVALID',
  )
})

test('activation idempotently pins the managed instance to the app-key ref', async () => {
  const seed = buildSeed()
  const userId = randomUUID()
  const catalogId = randomUUID()
  const instanceId = randomUUID()
  const fake = makeExternalAgentPrismaFake({
    ...seed,
    accountLinks: [linkedAccount(seed, userId)],
    catalogEntries: [{
      authMethod: 'bearer',
      defaultTransportConfig: {
        transport: 'http',
        url: 'https://api.deepsignal.live/mcp',
      },
      id: catalogId,
      integratedProductSlugs: ['deepsignal'],
      name: 'deepsignal',
      status: 'published',
      visibility: 'public',
    }],
    instances: [{
      catalogEntryId: catalogId,
      credentialRef: 'secret_oauth_obsolete',
      id: instanceId,
      lifecycleState: 'pending_setup',
      organizationId: seed.organizationId,
      scopeId: userId,
      scopeType: 'user',
      transportConfig: { url: 'https://untrusted.invalid/mcp' },
    }],
    teamEnablements: [{
      teamId: seed.teamId,
      productSlug: 'deepsignal',
      enabled: true,
    }],
  })
  fake.credentialOverrides.push({ instanceId })

  const first = await activateExternalAgentProduct(
    asPrisma(fake),
    'deepsignal',
    buildCtx(seed, userId),
  )
  const second = await activateExternalAgentProduct(
    asPrisma(fake),
    'deepsignal',
    buildCtx(seed, userId),
  )

  assert.deepEqual(second, first)
  assert.equal(first.instanceId, instanceId)
  assert.equal(fake.instances.length, 1)
  assert.equal(fake.instances[0]?.credentialRef, 'DEEPSIGNAL_MCP_APP_KEY')
  assert.equal(fake.instances[0]?.lifecycleState, 'active')
  assert.deepEqual(fake.instances[0]?.transportConfig, {})
  assert.equal(fake.credentialOverrides.length, 0)
  assert.equal(fake.accountLinks[0]?.status, 'linked')
  assert.equal(fake.channelsById.size, 1)
  const [channel] = [...fake.channelsById.values()]
  assert.equal(channel?.systemChannelType, 'external_agent')
})

test('first activation provisions one managed user-scoped app-key instance', async () => {
  const seed = buildSeed()
  const userId = randomUUID()
  const catalogId = randomUUID()
  const fake = makeExternalAgentPrismaFake({
    ...seed,
    accountLinks: [linkedAccount(seed, userId)],
    catalogEntries: [{
      authMethod: 'bearer',
      defaultTransportConfig: {
        transport: 'http',
        url: 'https://api.deepsignal.live/mcp',
      },
      id: catalogId,
      integratedProductSlugs: ['deepsignal'],
      name: 'deepsignal',
      status: 'published',
      visibility: 'public',
    }],
    teamEnablements: [{
      teamId: seed.teamId,
      productSlug: 'deepsignal',
      enabled: true,
    }],
  })

  const result = await activateExternalAgentProduct(
    asPrisma(fake),
    'deepsignal',
    buildCtx(seed, userId),
  )

  assert.equal(fake.instances.length, 1)
  assert.equal(fake.instances[0]?.id, result.instanceId)
  assert.equal(fake.instances[0]?.scopeType, 'user')
  assert.equal(fake.instances[0]?.scopeId, userId)
  assert.equal(fake.instances[0]?.credentialRef, 'DEEPSIGNAL_MCP_APP_KEY')
  assert.equal(fake.instances[0]?.lifecycleState, 'active')
})

test('deactivation removes only the managed instance and revokes the link', async () => {
  const seed = buildSeed()
  const userId = randomUUID()
  const catalogId = randomUUID()
  const fake = makeExternalAgentPrismaFake({
    ...seed,
    accountLinks: [linkedAccount(seed, userId)],
    catalogEntries: [{
      authMethod: 'bearer',
      defaultTransportConfig: {
        transport: 'http',
        url: 'https://api.deepsignal.live/mcp',
      },
      id: catalogId,
      integratedProductSlugs: ['deepsignal'],
      name: 'deepsignal',
      status: 'published',
      visibility: 'public',
    }],
    instances: [{
      catalogEntryId: catalogId,
      credentialRef: 'DEEPSIGNAL_MCP_APP_KEY',
      id: randomUUID(),
      lifecycleState: 'active',
      organizationId: seed.organizationId,
      scopeId: userId,
      scopeType: 'user',
    }],
    teamEnablements: [{
      teamId: seed.teamId,
      productSlug: 'deepsignal',
      enabled: true,
    }],
  })
  fake.toolRegistryEntries.push({
    id: randomUUID(),
    mcpInstanceId: fake.instances[0]!.id,
  })

  await activateExternalAgentProduct(
    asPrisma(fake),
    'deepsignal',
    buildCtx(seed, userId),
  )
  const result = await deactivateExternalAgentProduct(
    asPrisma(fake),
    'deepsignal',
    { organizationId: seed.organizationId, userId },
  )

  assert.ok(result.channelId)
  assert.ok(result.instanceId)
  assert.equal(fake.instances.length, 0)
  assert.equal(fake.toolRegistryEntries.length, 0)
  assert.equal(fake.accountLinks[0]?.status, 'revoked')
  const [channel] = [...fake.channelsById.values()]
  assert.ok(channel?.archivedAt instanceof Date)
})

test('same-name public catalog without the product link cannot receive the app key', async () => {
  const seed = buildSeed()
  const userId = randomUUID()
  const fake = makeExternalAgentPrismaFake({
    ...seed,
    accountLinks: [linkedAccount(seed, userId)],
    catalogEntries: [{
      authMethod: 'bearer',
      defaultTransportConfig: {
        transport: 'http',
        url: 'https://api.deepsignal.live/mcp',
      },
      id: randomUUID(),
      integratedProductSlugs: [],
      name: 'deepsignal',
      status: 'published',
      visibility: 'public',
    }],
    teamEnablements: [{
      teamId: seed.teamId,
      productSlug: 'deepsignal',
      enabled: true,
    }],
  })

  await assert.rejects(
    activateExternalAgentProduct(
      asPrisma(fake),
      'deepsignal',
      buildCtx(seed, userId),
    ),
    (error: unknown) =>
      error instanceof ExternalAgentActivationError
      && error.code === 'EXTERNAL_AGENT_CATALOG_ENTRY_NOT_FOUND',
  )
  assert.equal(fake.instances.length, 0)
})

test('canonical catalog cannot target a non-DeepSignal origin', async () => {
  const seed = buildSeed()
  const userId = randomUUID()
  const fake = makeExternalAgentPrismaFake({
    ...seed,
    accountLinks: [linkedAccount(seed, userId)],
    catalogEntries: [{
      authMethod: 'bearer',
      defaultTransportConfig: {
        transport: 'http',
        url: 'https://attacker.invalid/mcp',
      },
      id: randomUUID(),
      integratedProductSlugs: ['deepsignal'],
      name: 'deepsignal',
      status: 'published',
      visibility: 'public',
    }],
    teamEnablements: [{
      teamId: seed.teamId,
      productSlug: 'deepsignal',
      enabled: true,
    }],
  })

  await assert.rejects(
    activateExternalAgentProduct(
      asPrisma(fake),
      'deepsignal',
      buildCtx(seed, userId),
    ),
    (error: unknown) =>
      error instanceof ExternalAgentActivationError
      && error.code === 'EXTERNAL_AGENT_CATALOG_CONTRACT_INVALID',
  )
  assert.equal(fake.instances.length, 0)
})
