import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import type { DeepWaterBriefInput } from '@nessie/schemas'

import {
  DeepWaterAgentGrantMissingError,
  DeepWaterBriefNotReadyError,
  claimAgentOriginRun,
  createPersonDeepWaterBrief,
} from '../src/deepwater-brief-creation.js'
import { deepWaterIntegrationPluginManifest } from '../src/integration-plugin-manifests/deep-water.js'
import { projectMcpToolDescriptors } from '../src/mcp-tool-registry-projection.js'
import { runWithDeepWaterTransitionLock } from '../src/deepwater-transition-lock.js'

/**
 * Brief creation re-reads the team's DeepWater switch and current-contract
 * connector inside the team transition lock (Water plan amendments N8.2), and
 * an agent's claim re-reads its own grant under its policy lock. These are
 * lock-ordering guarantees, so only PostgreSQL can show them.
 */

const runIfDatabase = process.env.DATABASE_URL ? test : test.skip

const input: DeepWaterBriefInput = {
  schemaVersion: 1,
  topic: 'Heat pumps in older houses',
  context: null,
  pillars: null,
  settings: null,
  originRootMessageId: null,
}

type Seed = {
  prisma: PrismaClient
  sql: (text: string, ...values: unknown[]) => Promise<Array<Record<string, unknown>>>
  ids: Record<'organization' | 'project' | 'team' | 'channel' | 'thread' | 'requester' | 'agent' | 'run' | 'instance', string>
  cleanup: () => Promise<void>
}

const seed = async (): Promise<Seed> => {
  const prisma = new PrismaClient()
  const sql = (text: string, ...values: unknown[]) =>
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(text, ...values)
  const ids = {
    organization: randomUUID(), project: randomUUID(), team: randomUUID(), channel: randomUUID(),
    thread: randomUUID(), requester: randomUUID(), agent: randomUUID(), run: randomUUID(), instance: randomUUID(),
  }
  const statements = [
    [`INSERT INTO organizations (id, name, created_at, updated_at) VALUES ($1::uuid, 'Brief creation', now(), now())`, [ids.organization]],
    [`INSERT INTO projects (id, name, organization_id, created_at, updated_at) VALUES ($1::uuid, 'P', $2::uuid, now(), now())`, [ids.project, ids.organization]],
    [`INSERT INTO teams (id, name, project_id, created_at, updated_at) VALUES ($1::uuid, 'T', $2::uuid, now(), now())`, [ids.team, ids.project]],
    [`INSERT INTO channels (id, label, slug, organization_id, project_id, team_id, created_at, updated_at)
      VALUES ($1::uuid, 'C', $2, $3::uuid, $4::uuid, $5::uuid, now(), now())`, [ids.channel, `c-${ids.channel}`, ids.organization, ids.project, ids.team]],
    [`INSERT INTO threads (id, channel_id, created_at, updated_at) VALUES ($1::uuid, $2::uuid, now(), now())`, [ids.thread, ids.channel]],
    [`INSERT INTO users (id, email, display_name, updated_at) VALUES ($1::uuid, $2, 'R', now())`, [ids.requester, `${ids.requester}@brief.test`]],
    [`INSERT INTO agents (id, name, organization_id, team_id, updated_at) VALUES ($1::uuid, 'A', $2::uuid, $3::uuid, now())`, [ids.agent, ids.organization, ids.team]],
    [`INSERT INTO runs (id, agent_id, thread_id) VALUES ($1::uuid, $2::uuid, $3::uuid)`, [ids.run, ids.agent, ids.thread]],
    [`INSERT INTO product_team_enablements (organization_id, team_id, product_slug, enabled, updated_at)
      VALUES ($1::uuid, $2::uuid, 'deep-water', true, now())`, [ids.organization, ids.team]],
    [`INSERT INTO mcp_server_instances (id, catalog_entry_id, organization_id, scope_type, scope_id, installed_by,
        lifecycle_state, discovered_tools, updated_at)
      SELECT $1::uuid, "id", $2::uuid, 'team', $3::uuid, $4::uuid, 'active', $5::jsonb, now()
      FROM mcp_catalog_entries WHERE "name" = 'deep-water' AND "organization_id" IS NULL`,
      [ids.instance, ids.organization, ids.team, ids.requester,
        JSON.stringify(deepWaterIntegrationPluginManifest.mcp.tools.map((tool) => ({ name: tool.name })))]],
  ] as const
  for (const [text, values] of statements) await prisma.$executeRawUnsafe(text, ...values)

  await prisma.$transaction((tx) => projectMcpToolDescriptors(tx, {
    organizationId: ids.organization,
    instance: { id: ids.instance, scopeType: 'team', scopeId: ids.team },
    descriptors: deepWaterIntegrationPluginManifest.mcp.tools.map((tool) => ({
      name: tool.name, title: tool.label, description: tool.description, inputSchema: tool.inputSchema,
    })),
  }))
  await prisma.toolRegistryEntry.updateMany({
    where: { mcpInstanceId: ids.instance },
    data: { status: 'active', metadata: { requiresExplicitGrant: true } },
  })
  return {
    prisma,
    sql,
    ids,
    cleanup: async () => {
      await prisma.$executeRawUnsafe(`DELETE FROM queue_jobs WHERE payload->>'organizationId' = $1`, ids.organization)
      await prisma.$executeRawUnsafe('DELETE FROM organizations WHERE id = $1::uuid', ids.organization)
      await prisma.$executeRawUnsafe('DELETE FROM users WHERE id = $1::uuid', ids.requester)
      await prisma.$disconnect()
    },
  }
}

const withSeed = (name: string, body: (s: Seed) => Promise<void>): void => {
  runIfDatabase(name, async () => {
    const s = await seed()
    try {
      await body(s)
    } finally {
      await s.cleanup()
    }
  })
}

const common = (s: Seed) => ({
  organizationId: s.ids.organization,
  teamId: s.ids.team,
  requestedByUserId: s.ids.requester,
  channelId: s.ids.channel,
  threadId: s.ids.thread,
  identity: { subject: 'uoa|r', organizationId: 'uoa-org', teamId: 'uoa-team', tokenVersion: 1 },
  input,
  sourceScopes: [],
  disclosureSources: [],
})

const setEnabled = (s: Seed, enabled: boolean) => s.prisma.productTeamEnablement.updateMany({
  where: { organizationId: s.ids.organization, teamId: s.ids.team, productSlug: 'deep-water' },
  data: { enabled },
})

const notReady = (reason: string) => (error: unknown) =>
  error instanceof DeepWaterBriefNotReadyError && error.reason === reason

withSeed('a person brief is created only on a ready team, bound to its connector, with its opening action queued', async (s) => {
  const actionId = randomUUID()
  const created = await createPersonDeepWaterBrief(s.prisma, { ...common(s), actionId })
  assert.equal(created.created, true)
  assert.equal(created.run.connectorId, s.ids.instance)
  const jobs = await s.sql(`SELECT topic FROM queue_jobs WHERE idempotency_key = $1`,
    `deep-water-brief-action:${created.run.id}:${actionId}`)
  assert.deepEqual(jobs.map((row) => row.topic), ['deep_water.brief.action'])

  // A replay returns the same brief even once the team is off.
  await setEnabled(s, false)
  const replay = await createPersonDeepWaterBrief(s.prisma, { ...common(s), actionId })
  assert.deepEqual({ id: replay.run.id, created: replay.created }, { id: created.run.id, created: false })
  await assert.rejects(createPersonDeepWaterBrief(s.prisma, { ...common(s), actionId: randomUUID() }), notReady('team_off'))
})

withSeed('a team on an older tool contract, or with no active connector, is not ready', async (s) => {
  await s.prisma.mcpServerInstance.update({
    where: { id: s.ids.instance },
    data: { discoveredTools: [{ name: 'research_start' }, { name: 'research_status' }] },
  })
  await assert.rejects(createPersonDeepWaterBrief(s.prisma, { ...common(s), actionId: randomUUID() }), notReady('contract_outdated'))
  await s.prisma.mcpServerInstance.update({ where: { id: s.ids.instance }, data: { lifecycleState: 'paused' } })
  await assert.rejects(createPersonDeepWaterBrief(s.prisma, { ...common(s), actionId: randomUUID() }), notReady('unavailable'))
  assert.equal(await s.prisma.productIntegrationRun.count({ where: { organizationId: s.ids.organization } }), 0)
})

withSeed('an agent claims a brief only while its policy grants opening one, idempotently per tool call', async (s) => {
  const claim = (toolCallId: string) => claimAgentOriginRun(s.prisma, {
    ...common(s), agentId: s.ids.agent, originRunId: s.ids.run, toolCallId, principalUserId: s.ids.requester,
  })
  await assert.rejects(claim('call_1'), DeepWaterAgentGrantMissingError)

  const entry = await s.prisma.toolRegistryEntry.findFirstOrThrow({
    where: { mcpInstanceId: s.ids.instance, transportConfig: { path: ['toolName'], equals: 'research_scope_start' } },
    select: { id: true },
  })
  await s.prisma.agent.update({ where: { id: s.ids.agent }, data: { toolPolicy: { [entry.id]: true } } })
  const claimed = await claim('call_1')
  assert.equal(claimed.created, true)
  assert.equal(claimed.run.originKind, 'agent')
  assert.equal(claimed.run.originToolCallId, 'call_1')
  assert.equal(claimed.run.principalUserId, s.ids.requester)
  assert.equal((await claim('call_1')).run.id, claimed.run.id)
})

withSeed('creation waits for a disable holding the team lock, then sees the team off', async (s) => {
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  const team = { organizationId: s.ids.organization, teamId: s.ids.team }
  const disable = runWithDeepWaterTransitionLock(s.prisma, team, async (tx) => {
    await tx.productTeamEnablement.updateMany({
      where: { organizationId: s.ids.organization, teamId: s.ids.team, productSlug: 'deep-water' },
      data: { enabled: false },
    })
    await held
  })
  // Give the disable time to take the lock before creation asks for it.
  await new Promise((resolve) => setTimeout(resolve, 100))
  const creation = createPersonDeepWaterBrief(s.prisma, { ...common(s), actionId: randomUUID() })
  await new Promise((resolve) => setTimeout(resolve, 100))
  release()
  await disable
  await assert.rejects(creation, notReady('team_off'))
})
