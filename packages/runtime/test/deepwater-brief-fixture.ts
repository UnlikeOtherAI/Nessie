import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import type { DeepWaterBriefInput, DeepWaterRequesterIdentity } from '@nessie/schemas'
import { Pool } from 'pg'

import {
  insertDeepWaterBriefRun,
  type DeepWaterBriefRunInsertResult,
  type DeepWaterBriefRunOrigin,
} from '../src/deepwater-brief-run-insert.js'

/**
 * One isolated tenant for the DeepWater brief Postgres suites: an organisation
 * with a project, team, channel and thread, a requester, an agent with an
 * origin Run, and a team connector on the first-party DeepWater catalog entry.
 * Everything hangs off the organisation, so one delete cleans it up; the users
 * are removed by id.
 */

export type BriefFixture = {
  pool: Pool
  prisma: PrismaClient
  ids: {
    organization: string
    project: string
    team: string
    channel: string
    thread: string
    requester: string
    member: string
    agent: string
    originRun: string
    connector: string
  }
  identity: DeepWaterRequesterIdentity
  cleanup: () => Promise<void>
}

export const briefInput = (overrides: Partial<DeepWaterBriefInput> = {}): DeepWaterBriefInput => ({
  schemaVersion: 1,
  topic: 'Heat pumps in older houses',
  context: null,
  pillars: null,
  settings: { depth: 'light' },
  originRootMessageId: null,
  ...overrides,
})

export const seedBriefFixture = async (): Promise<BriefFixture> => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const prisma = new PrismaClient()
  const ids = {
    organization: randomUUID(),
    project: randomUUID(),
    team: randomUUID(),
    channel: randomUUID(),
    thread: randomUUID(),
    requester: randomUUID(),
    member: randomUUID(),
    agent: randomUUID(),
    originRun: randomUUID(),
    connector: randomUUID(),
  }
  await pool.query(
    `INSERT INTO organizations (id, name, created_at, updated_at) VALUES ($1, 'DeepWater briefs', now(), now())`,
    [ids.organization],
  )
  await pool.query(
    `INSERT INTO projects (id, name, organization_id, created_at, updated_at) VALUES ($1, 'Briefs', $2, now(), now())`,
    [ids.project, ids.organization],
  )
  await pool.query(
    `INSERT INTO teams (id, name, project_id, created_at, updated_at) VALUES ($1, 'Briefs', $2, now(), now())`,
    [ids.team, ids.project],
  )
  await pool.query(
    `INSERT INTO channels (id, label, slug, organization_id, project_id, team_id, created_at, updated_at)
     VALUES ($1, 'Briefs', $2, $3, $4, $5, now(), now())`,
    [ids.channel, `briefs-${ids.channel}`, ids.organization, ids.project, ids.team],
  )
  await pool.query(
    `INSERT INTO threads (id, channel_id, created_at, updated_at) VALUES ($1, $2, now(), now())`,
    [ids.thread, ids.channel],
  )
  for (const userId of [ids.requester, ids.member]) {
    await pool.query(
      `INSERT INTO users (id, email, display_name, updated_at) VALUES ($1, $2, 'Brief tester', now())`,
      [userId, `${userId}@briefs.test`],
    )
  }
  await pool.query(
    `INSERT INTO agents (id, name, organization_id, team_id, project_id, updated_at)
     VALUES ($1, 'Research agent', $2, $3, $4, now())`,
    [ids.agent, ids.organization, ids.team, ids.project],
  )
  // Terminal, so no run sweep in a concurrently running suite ever picks it up.
  await pool.query(
    `INSERT INTO runs (id, agent_id, thread_id, status) VALUES ($1, $2, $3, 'completed')`,
    [ids.originRun, ids.agent, ids.thread],
  )
  await pool.query(
    `INSERT INTO mcp_server_instances (
       id, catalog_entry_id, organization_id, scope_type, scope_id, installed_by, lifecycle_state, updated_at
     )
     SELECT $1, "id", $2, 'team', $3, $4, 'active', now()
     FROM mcp_catalog_entries WHERE "name" = 'deep-water' AND "organization_id" IS NULL`,
    [ids.connector, ids.organization, ids.team, ids.requester],
  )
  return {
    pool,
    prisma,
    ids,
    identity: {
      subject: `uoa|${ids.requester}`,
      organizationId: `uoa-org-${ids.organization}`,
      teamId: `uoa-team-${ids.team}`,
      tokenVersion: 3,
    },
    cleanup: async () => {
      await prisma.$disconnect()
      // Brief actions enqueue jobs keyed to this tenant; nothing else owns them.
      await pool.query(`DELETE FROM queue_jobs WHERE payload->>'organizationId' = $1`, [ids.organization])
      await pool.query('DELETE FROM organizations WHERE id = $1', [ids.organization])
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[ids.requester, ids.member]])
      await pool.end()
    },
  }
}

export const personOrigin = (actionId: string = randomUUID()): DeepWaterBriefRunOrigin => ({
  kind: 'person',
  actionId,
})

export const agentOrigin = (fixture: BriefFixture, toolCallId = `call_${randomUUID()}`): DeepWaterBriefRunOrigin => ({
  kind: 'agent',
  agentId: fixture.ids.agent,
  runId: fixture.ids.originRun,
  toolCallId,
  principalUserId: fixture.ids.requester,
})

export const insertBrief = (
  fixture: BriefFixture,
  origin: DeepWaterBriefRunOrigin = personOrigin(),
): Promise<DeepWaterBriefRunInsertResult> =>
  fixture.prisma.$transaction((tx) => insertDeepWaterBriefRun(tx, {
    organizationId: fixture.ids.organization,
    teamId: fixture.ids.team,
    connectorId: fixture.ids.connector,
    requestedByUserId: fixture.ids.requester,
    channelId: fixture.ids.channel,
    threadId: fixture.ids.thread,
    identity: fixture.identity,
    input: briefInput(),
    sourceScopes: [{ scopeType: 'channel', scopeId: fixture.ids.channel }],
    disclosureSources: [{ sourceChannelId: fixture.ids.channel, sourceAuthorUserId: fixture.ids.requester }],
    origin,
  }))
