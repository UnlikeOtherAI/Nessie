import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import {
  loadAgentToolCatalog,
  readAgentRecordForActor,
} from '@nessie/workspace-admin'

/**
 * The two reads the Agent Designer's tools stand on, against a real database.
 *
 * `readAgentRecordForActor` is entitlement — the same `buildVisibleAgentWhere` +
 * `buildAgentVisibilityWhere` composition the Agents list applies — so every arm
 * of it is a database fact (the binding join, the private-visibility arm, the
 * organization-owner widening). A cast Prisma fake would assert the shape of a
 * query rather than that the rule bites.
 *
 * `loadAgentToolCatalog` is the member-safe projection that replaces the
 * owner-only `GET /api/mcp/tools` for a design conversation: it must pick up a
 * connector row the moment it exists, and must be structurally unable to emit
 * the transport, credential and grant state that row carries.
 *
 * Seed-scoped throughout: this database is shared with other suites running
 * concurrently, so nothing here deletes or counts globally.
 */

const suite = 'd25b'
const orgId = `00000000-0000-4000-8000-${suite}00000001`
const otherOrgId = `00000000-0000-4000-8000-${suite}0000001f`
const projectId = `00000000-0000-4000-8000-${suite}00000002`
const teamId = `00000000-0000-4000-8000-${suite}00000003`
const publicChannelId = `00000000-0000-4000-8000-${suite}00000004`

const ownerUserId = `00000000-0000-4000-8000-${suite}00000010`
const memberUserId = `00000000-0000-4000-8000-${suite}00000011`
const orgOwnerUserId = `00000000-0000-4000-8000-${suite}00000012`

const teamOwnedAgentId = `00000000-0000-4000-8000-${suite}00000020`
const privateAgentId = `00000000-0000-4000-8000-${suite}00000021`
const systemAgentId = `00000000-0000-4000-8000-${suite}00000022`

const connectorEntryId = `00000000-0000-4000-8000-${suite}00000030`
const grantedConnectorEntryId = `00000000-0000-4000-8000-${suite}00000031`
const foreignConnectorEntryId = `00000000-0000-4000-8000-${suite}00000032`

const userIds = [ownerUserId, memberUserId, orgOwnerUserId]

const dbTest = process.env.DATABASE_URL ? test : test.skip

const seed = async (prisma: PrismaClient) => {
  await prisma.organization.createMany({
    data: [
      { id: orgId, name: `designer-reads-${suite}` },
      { id: otherOrgId, name: `designer-reads-other-${suite}` },
    ],
  })
  await prisma.user.createMany({
    data: userIds.map((id, index) => ({
      displayName: `Designer reads ${index}`,
      email: `designer-reads-${suite}-${index}@test.local`,
      id,
    })),
  })
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: orgId, role: 'member', userId: ownerUserId },
      { organizationId: orgId, role: 'member', userId: memberUserId },
      { organizationId: orgId, role: 'owner', userId: orgOwnerUserId },
    ],
  })
  await prisma.project.create({
    data: { id: projectId, name: `p-${suite}`, organizationId: orgId },
  })
  await prisma.team.create({ data: { id: teamId, name: `t-${suite}`, projectId } })
  await prisma.channel.create({
    data: {
      id: publicChannelId,
      label: `pub-${suite}`,
      organizationId: orgId,
      projectId,
      slug: `pub-${suite}`,
      teamId,
      visibility: 'public',
    },
  })
  await prisma.agent.createMany({
    data: [
      {
        id: teamOwnedAgentId,
        name: `Team owned ${suite}`,
        organizationId: orgId,
        projectId,
        role: 'assistant',
        systemPrompt: 'Answer questions about the roadmap.',
        teamId,
      },
      {
        id: privateAgentId,
        name: `Private ${suite}`,
        organizationId: orgId,
        ownerUserId,
        projectId,
        role: 'assistant',
        teamId,
        visibility: 'private',
      },
      {
        id: systemAgentId,
        name: `Blueprint ${suite}`,
        organizationId: orgId,
        role: 'agent designer',
        systemManaged: true,
        systemPrompt: 'Blueprint instructions.',
        toolPolicy: { delegate: false },
      },
    ],
  })
  await prisma.agentBinding.create({
    data: { agentId: teamOwnedAgentId, channelId: publicChannelId },
  })
}

const cleanup = async (prisma: PrismaClient) => {
  await prisma.toolRegistryEntry.deleteMany({
    where: {
      id: { in: [connectorEntryId, grantedConnectorEntryId, foreignConnectorEntryId] },
    },
  })
  await prisma.agentBinding.deleteMany({ where: { channelId: publicChannelId } })
  await prisma.agent.deleteMany({ where: { organizationId: { in: [orgId, otherOrgId] } } })
  await prisma.channel.deleteMany({ where: { id: publicChannelId } })
  await prisma.team.deleteMany({ where: { id: teamId } })
  await prisma.project.deleteMany({ where: { id: projectId } })
  await prisma.organizationMember.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } })
}

const withDb = async (run: (prisma: PrismaClient) => Promise<void>) => {
  const prisma = new PrismaClient()
  try {
    await cleanup(prisma)
    await seed(prisma)
    await run(prisma)
  } finally {
    await cleanup(prisma)
    await prisma.$disconnect()
  }
}

const read = (
  prisma: PrismaClient,
  userId: string,
  agentId: string,
  isOwner = false,
) => readAgentRecordForActor(prisma, { agentId, isOwner, organizationId: orgId, userId })

dbTest('a team-owned agent reads through a channel the person can see', async () => {
  await withDb(async (prisma) => {
    const result = await read(prisma, memberUserId, teamOwnedAgentId)
    assert.ok(result)
    assert.equal(result.config.name, `Team owned ${suite}`)
    assert.equal(result.config.systemPrompt, 'Answer questions about the roadmap.')
    // Not system managed, so the full record travels with it.
    assert.ok(result.record)
    assert.deepEqual(result.record.channelIds, [publicChannelId])
  })
})

dbTest('another person’s private agent is invisible, org owner included', async () => {
  await withDb(async (prisma) => {
    assert.equal(await read(prisma, memberUserId, privateAgentId), null)
    // Private beats owner omniscience: the widening arm does not reach it.
    assert.equal(await read(prisma, orgOwnerUserId, privateAgentId, true), null)
    // Its own owner reads it.
    const own = await read(prisma, ownerUserId, privateAgentId)
    assert.equal(own?.config.visibility, 'private')
  })
})

dbTest('a blueprint-managed agent answers with configuration only', async () => {
  await withDb(async (prisma) => {
    const result = await read(prisma, memberUserId, systemAgentId)
    assert.ok(result)
    assert.equal(result.config.systemManaged, true)
    assert.equal(result.config.systemPrompt, 'Blueprint instructions.')
    assert.deepEqual(result.config.toolPolicy, { delegate: false })
    // Activity, messages, children and other people's bindings stay closed.
    assert.equal(result.record, null)
  })
})

dbTest('an agent in another organization is not readable', async () => {
  await withDb(async (prisma) => {
    const foreign = await prisma.agent.create({
      data: {
        name: `Foreign ${suite}`,
        organizationId: otherOrgId,
        role: 'assistant',
      },
    })
    assert.equal(await read(prisma, orgOwnerUserId, foreign.id, true), null)
  })
})

const seedRegistryEntry = (
  prisma: PrismaClient,
  input: { id: string; organizationId: string; label: string; metadata?: unknown },
) =>
  prisma.toolRegistryEntry.create({
    data: {
      description: 'Create a ticket in the tracker.',
      enabled: true,
      handlerKind: 'mcp',
      id: input.id,
      label: input.label,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata as never }),
      organizationId: input.organizationId,
      overview: 'Ticket creation.',
      scopeKey: `scope-${suite}-${input.id.slice(-4)}`,
      source: 'mcp_remote',
      status: 'active',
      toolId: `ticket_create_${suite}_${input.id.slice(-4)}`,
      transport: 'mcp',
      transportConfig: {
        // Exactly the shape the projection must be incapable of emitting.
        credentialRef: 'secret_designer_catalogue_probe',
        headers: { Authorization: 'Bearer designer-catalogue-probe' },
        url: 'https://tickets.example.invalid/mcp',
      },
    },
  })

dbTest('the catalogue lists a live connector and can emit no secret', async () => {
  await withDb(async (prisma) => {
    const before = await loadAgentToolCatalog(prisma, { organizationId: orgId })
    assert.equal(
      before.togglable.some((entry) => entry.key === connectorEntryId),
      false,
    )
    // Every builtin arrives from the definitions, so the catalogue is never
    // empty even before a registry seed has run for this organization.
    assert.ok(before.togglable.some((entry) => entry.key === 'web_search'))

    await seedRegistryEntry(prisma, {
      id: connectorEntryId,
      label: `Ticket create ${suite}`,
      organizationId: orgId,
    })
    await seedRegistryEntry(prisma, {
      id: grantedConnectorEntryId,
      label: `Granted tool ${suite}`,
      metadata: { requiresExplicitGrant: true },
      organizationId: orgId,
    })
    await seedRegistryEntry(prisma, {
      id: foreignConnectorEntryId,
      label: `Foreign tool ${suite}`,
      organizationId: otherOrgId,
    })

    const after = await loadAgentToolCatalog(prisma, { organizationId: orgId })
    const connector = after.togglable.find((entry) => entry.key === connectorEntryId)
    assert.ok(connector, 'the new connector row is in the catalogue')
    // Keyed by the registry uuid and allow-mode, exactly as the worker reads it.
    assert.equal(connector.allowMode, true)
    assert.equal(connector.defaultEnabled, false)
    assert.equal(connector.kind, 'connector')

    // A grant-requiring row is NAMED but never togglable.
    assert.equal(
      after.togglable.some((entry) => entry.key === grantedConnectorEntryId),
      false,
    )
    assert.ok(
      after.restricted.some(
        (entry) =>
          entry.key === grantedConnectorEntryId && entry.restriction === 'explicit_grant',
      ),
    )
    // Another organization's tools are not this organization's catalogue.
    assert.equal(
      [...after.togglable, ...after.restricted].some(
        (entry) => entry.key === foreignConnectorEntryId,
      ),
      false,
    )

    // Shape, not a happy path: nothing anywhere in the projection can carry a
    // credential, an endpoint, an auth header, transport config or grant state.
    const serialised = JSON.stringify(after)
    for (const forbidden of [
      'credentialRef',
      'secret_designer_catalogue_probe',
      'designer-catalogue-probe',
      'Authorization',
      'tickets.example.invalid',
      'transportConfig',
      'grants',
    ]) {
      assert.equal(
        serialised.includes(forbidden),
        false,
        `the catalogue must not emit ${forbidden}`,
      )
    }
    const fields = new Set(
      [...after.togglable, ...after.restricted].flatMap((entry) => Object.keys(entry)),
    )
    assert.deepEqual(
      [...fields].sort(),
      [
        'allowMode',
        'defaultEnabled',
        'group',
        'key',
        'kind',
        'label',
        'requiresTodos',
        'restriction',
        'summary',
      ],
    )
  })
})

dbTest('personal-assistant-only and explicit-grant builtins are named, not offered', async () => {
  await withDb(async (prisma) => {
    const catalogue = await loadAgentToolCatalog(prisma, { organizationId: orgId })
    const restricted = new Map(
      catalogue.restricted.map((entry) => [entry.key, entry.restriction]),
    )
    // The design verbs are the Agent Designer's, not the Personal Assistant's
    // (phase 4) — so the catalogue must not tell a designed agent's author that
    // "a Personal Assistant may use it", which is no longer true of them.
    assert.equal(restricted.get('agent_create'), 'built_in_specialist_only')
    assert.equal(restricted.get('agent_update'), 'built_in_specialist_only')
    // An operational verb the PA keeps still reads as PA-only.
    assert.equal(restricted.get('agent_bind_channel'), 'personal_assistant_only')
    assert.equal(restricted.get('deep_water_run_update'), 'explicit_grant')
    // …and none of them can be switched on from a design conversation.
    for (const key of restricted.keys()) {
      assert.equal(
        catalogue.togglable.some((entry) => entry.key === key),
        false,
      )
    }
    // A to-do tool is offerable but flagged as needing the owner-gated switch.
    const todo = catalogue.togglable.find((entry) => entry.key === 'todo_start')
    assert.equal(todo?.requiresTodos, true)
  })
})

dbTest('a builtin disabled for the organization leaves the catalogue', async () => {
  await withDb(async (prisma) => {
    const entry = await prisma.toolRegistryEntry.create({
      data: {
        builtin: true,
        description: 'Search the public web.',
        enabled: false,
        handlerKind: 'builtin',
        label: 'Web Search',
        organizationId: orgId,
        overview: 'Web search.',
        scopeKey: 'builtin',
        toolId: 'web_search',
      },
    })
    try {
      const catalogue = await loadAgentToolCatalog(prisma, { organizationId: orgId })
      assert.equal(
        catalogue.togglable.some((tool) => tool.key === 'web_search'),
        false,
      )
    } finally {
      await prisma.toolRegistryEntry.delete({ where: { id: entry.id } })
    }
  })
})
