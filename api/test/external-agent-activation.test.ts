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
import { asPrisma, makeExternalAgentPrismaFake } from './helpers/external-agent-prisma-fake.js'

const buildSeed = () => ({
  organizationId: randomUUID(),
  projectId: randomUUID(),
  teamId: randomUUID(),
})

const actorContextFor = (organizationId: string, userId: string): AuthorizedActionContext =>
  ({
    tenant: { organizationId },
    actor: { actorId: userId, actorType: 'user' },
    actionContext: {},
  }) as unknown as AuthorizedActionContext

const buildCtx = (
  seed: { organizationId: string; teamId: string },
  userId: string,
  startInstanceOAuth: (instanceId: string) => Promise<string>,
): ExternalAgentActivationContext => ({
  actorContext: actorContextFor(seed.organizationId, userId),
  organizationId: seed.organizationId,
  userId,
  teamId: seed.teamId,
  startInstanceOAuth,
})

test('activation rejects an unknown external-agent product', async () => {
  const seed = buildSeed()
  const fake = makeExternalAgentPrismaFake(seed)
  await assert.rejects(
    activateExternalAgentProduct(asPrisma(fake), 'not-a-product', buildCtx(seed, randomUUID(), async () => '')),
    (error: unknown) =>
      error instanceof ExternalAgentActivationError && error.code === 'EXTERNAL_AGENT_UNKNOWN_PRODUCT',
  )
})

test('activation is blocked when the team is not enabled', async () => {
  const seed = buildSeed()
  const userId = randomUUID()
  const fake = makeExternalAgentPrismaFake({
    ...seed,
    catalogEntries: [
      { id: randomUUID(), name: 'deepsignal', visibility: 'public', status: 'published', authMethod: 'oauth2' },
    ],
    // no team enablement row → gate closed
  })
  await assert.rejects(
    activateExternalAgentProduct(asPrisma(fake), 'deepsignal', buildCtx(seed, userId, async () => '')),
    (error: unknown) =>
      error instanceof ExternalAgentActivationError && error.code === 'EXTERNAL_AGENT_TEAM_NOT_ENABLED',
  )
  // Nothing was provisioned.
  assert.equal(fake.channelsById.size, 0)
  assert.equal(fake.accountLinks.length, 0)
})

test('activation with a pending OAuth instance returns an authorize URL and needs_auth link', async () => {
  const seed = buildSeed()
  const userId = randomUUID()
  const catalogId = randomUUID()
  const instanceId = randomUUID()
  const fake = makeExternalAgentPrismaFake({
    ...seed,
    catalogEntries: [
      { id: catalogId, name: 'deepsignal', visibility: 'public', status: 'published', authMethod: 'oauth2' },
    ],
    instances: [
      {
        id: instanceId,
        organizationId: seed.organizationId,
        catalogEntryId: catalogId,
        scopeType: 'user',
        scopeId: userId,
        lifecycleState: 'pending_setup',
      },
    ],
    teamEnablements: [{ teamId: seed.teamId, productSlug: 'deepsignal', enabled: true }],
  })

  let oauthCalls = 0
  const result = await activateExternalAgentProduct(
    asPrisma(fake),
    'deepsignal',
    buildCtx(seed, userId, async (id) => {
      oauthCalls += 1
      assert.equal(id, instanceId)
      return 'https://authentication.unlikeotherai.com/authorize?state=abc'
    }),
  )

  assert.equal(oauthCalls, 1)
  assert.equal(result.instanceId, instanceId)
  assert.equal(result.authorizeUrl, 'https://authentication.unlikeotherai.com/authorize?state=abc')
  assert.ok(result.channelId)

  // Link recorded as needs_auth, and the conversation channel was bootstrapped.
  assert.equal(fake.accountLinks.length, 1)
  assert.equal(fake.accountLinks[0]?.status, 'needs_auth')
  assert.equal(fake.channelsById.size, 1)
  const [channel] = [...fake.channelsById.values()]
  assert.equal(channel?.systemChannelType, 'external_agent')
})

test('activation with an already-active instance links without an authorize URL', async () => {
  const seed = buildSeed()
  const userId = randomUUID()
  const catalogId = randomUUID()
  const fake = makeExternalAgentPrismaFake({
    ...seed,
    catalogEntries: [
      { id: catalogId, name: 'deepsignal', visibility: 'public', status: 'published', authMethod: 'oauth2' },
    ],
    instances: [
      {
        id: randomUUID(),
        organizationId: seed.organizationId,
        catalogEntryId: catalogId,
        scopeType: 'user',
        scopeId: userId,
        lifecycleState: 'active',
      },
    ],
    teamEnablements: [{ teamId: seed.teamId, productSlug: 'deepsignal', enabled: true }],
  })

  let oauthCalls = 0
  const result = await activateExternalAgentProduct(
    asPrisma(fake),
    'deepsignal',
    buildCtx(seed, userId, async () => {
      oauthCalls += 1
      return ''
    }),
  )

  assert.equal(oauthCalls, 0)
  assert.equal(result.authorizeUrl, undefined)
  assert.equal(fake.accountLinks[0]?.status, 'linked')
})

test('deactivation uninstalls the instance, revokes the link, and archives the channel', async () => {
  const seed = buildSeed()
  const userId = randomUUID()
  const catalogId = randomUUID()
  const fake = makeExternalAgentPrismaFake({
    ...seed,
    catalogEntries: [
      { id: catalogId, name: 'deepsignal', visibility: 'public', status: 'published', authMethod: 'oauth2' },
    ],
    instances: [
      {
        id: randomUUID(),
        organizationId: seed.organizationId,
        catalogEntryId: catalogId,
        scopeType: 'user',
        scopeId: userId,
        lifecycleState: 'active',
      },
    ],
    teamEnablements: [{ teamId: seed.teamId, productSlug: 'deepsignal', enabled: true }],
  })
  fake.toolRegistryEntries.push({ id: randomUUID(), mcpInstanceId: fake.instances[0]!.id })

  // Activate first so there is a channel + account link to tear down.
  await activateExternalAgentProduct(
    asPrisma(fake),
    'deepsignal',
    buildCtx(seed, userId, async () => ''),
  )
  assert.equal(fake.instances.length, 1)

  const result = await deactivateExternalAgentProduct(asPrisma(fake), 'deepsignal', {
    organizationId: seed.organizationId,
    userId,
  })

  assert.ok(result.channelId)
  assert.ok(result.instanceId)
  assert.equal(fake.instances.length, 0)
  assert.equal(fake.toolRegistryEntries.length, 0)
  assert.equal(fake.accountLinks[0]?.status, 'revoked')
  const [channel] = [...fake.channelsById.values()]
  assert.ok(channel?.archivedAt instanceof Date)
})
