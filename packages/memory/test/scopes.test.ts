import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool } from 'pg'
import { resolveAccessibleScopes } from '../src/scopes.js'

type QueryResult = { rowCount?: number | null; rows: Record<string, unknown>[] }

const createPoolStub = (
  handler: (sql: string, params: unknown[] | undefined) => QueryResult,
): Pool =>
  ({
    query: async (sql: string, params?: unknown[]) => handler(sql, params),
  }) as unknown as Pool

const ORG = '33333333-3333-3333-3333-333333333333'
const AGENT = '99999999-9999-9999-9999-999999999999'
const USER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

const zip = (types: string[], ids: string[]): Array<[string, string]> =>
  types.map((type, index) => [type, ids[index]!])

test('user_shared intersects the agent reach with the user membership', async () => {
  const pool = createPoolStub((sql) => {
    if (sql.includes('JOIN agent_bindings')) {
      // Agent is bound to two channels the user can access.
      return {
        rows: [
          { id: 'chan-1', projectId: 'proj-1', teamId: 'team-1' },
          { id: 'chan-2', projectId: 'proj-1', teamId: 'team-1' },
        ],
      }
    }
    if (sql.includes('FROM agents WHERE id')) {
      return { rows: [{ projectId: 'proj-1', teamId: 'team-1' }] }
    }
    if (sql.includes('FROM team_members')) {
      // User is a member of team-1.
      return { rows: [{ id: 'team-1' }] }
    }
    if (sql.includes('FROM project_members')) {
      return { rows: [{ id: 'proj-1' }] }
    }
    if (sql.includes('organization_members')) {
      return { rowCount: 1, rows: [{}] }
    }
    throw new Error(`Unexpected query: ${sql}`)
  })

  const scopes = await resolveAccessibleScopes(
    { agentId: AGENT, mode: 'user_shared', organizationId: ORG, userId: USER },
    pool,
  )

  const pairs = zip(scopes.audienceTypes, scopes.audienceIds)
  assert.deepEqual(scopes.channelIds.sort(), ['chan-1', 'chan-2'])
  assert.ok(pairs.some(([t, i]) => t === 'channel' && i === 'chan-1'))
  assert.ok(pairs.some(([t, i]) => t === 'channel' && i === 'chan-2'))
  assert.ok(pairs.some(([t, i]) => t === 'team' && i === 'team-1'))
  assert.ok(pairs.some(([t, i]) => t === 'project' && i === 'proj-1'))
  assert.ok(pairs.some(([t, i]) => t === 'organization' && i === ORG))
  // A shared agent must never read the user's private memory.
  assert.ok(!pairs.some(([t]) => t === 'user'))
})

test('user_shared drops a team the user is not a member of', async () => {
  const pool = createPoolStub((sql) => {
    if (sql.includes('JOIN agent_bindings')) {
      return { rows: [{ id: 'chan-1', projectId: 'proj-1', teamId: 'team-1' }] }
    }
    if (sql.includes('FROM agents WHERE id')) {
      return { rows: [{ projectId: null, teamId: null }] }
    }
    // User is NOT a member of team-1 or proj-1.
    if (sql.includes('FROM team_members')) {
      return { rows: [] }
    }
    if (sql.includes('FROM project_members')) {
      return { rows: [] }
    }
    if (sql.includes('organization_members')) {
      return { rowCount: 1, rows: [{}] }
    }
    throw new Error(`Unexpected query: ${sql}`)
  })

  const scopes = await resolveAccessibleScopes(
    { agentId: AGENT, mode: 'user_shared', organizationId: ORG, userId: USER },
    pool,
  )

  const pairs = zip(scopes.audienceTypes, scopes.audienceIds)
  assert.ok(!pairs.some(([t]) => t === 'team'))
  assert.ok(!pairs.some(([t]) => t === 'project'))
  assert.ok(pairs.some(([t, i]) => t === 'channel' && i === 'chan-1'))
})

test('personal_assistant grants the user full accessible scope plus private memory', async () => {
  const pool = createPoolStub((sql) => {
    if (sql.includes('FROM channels c') && !sql.includes('agent_bindings')) {
      return { rows: [{ id: 'chan-1' }, { id: 'chan-2' }] }
    }
    if (sql.includes('FROM teams t') && sql.includes('JOIN projects p')) {
      return { rows: [{ id: 'team-1' }] }
    }
    if (sql.includes('FROM projects p') && !sql.includes('FROM teams')) {
      return { rows: [{ id: 'proj-1' }] }
    }
    if (sql.includes('organization_members')) {
      return { rowCount: 1, rows: [{}] }
    }
    throw new Error(`Unexpected query: ${sql}`)
  })

  const scopes = await resolveAccessibleScopes(
    { agentId: AGENT, mode: 'personal_assistant', organizationId: ORG, userId: USER },
    pool,
  )

  const pairs = zip(scopes.audienceTypes, scopes.audienceIds)
  assert.ok(pairs.some(([t, i]) => t === 'channel' && i === 'chan-1'))
  assert.ok(pairs.some(([t, i]) => t === 'team' && i === 'team-1'))
  assert.ok(pairs.some(([t, i]) => t === 'project' && i === 'proj-1'))
  assert.ok(pairs.some(([t, i]) => t === 'organization' && i === ORG))
  // The PA acts as the user, so it reads the user's private memory.
  assert.ok(pairs.some(([t, i]) => t === 'user' && i === USER))
})

test('autonomous is bound by the agent configured scope, with no user-private', async () => {
  const pool = createPoolStub((sql) => {
    if (sql.includes('JOIN agent_bindings')) {
      return { rows: [{ id: 'chan-1', projectId: 'proj-1', teamId: 'team-1' }] }
    }
    if (sql.includes('FROM agents WHERE id')) {
      return { rows: [{ projectId: 'proj-2', teamId: 'team-2' }] }
    }
    throw new Error(`Unexpected query: ${sql}`)
  })

  const scopes = await resolveAccessibleScopes(
    { agentId: AGENT, mode: 'autonomous', organizationId: ORG, userId: null },
    pool,
  )

  const pairs = zip(scopes.audienceTypes, scopes.audienceIds)
  assert.ok(pairs.some(([t, i]) => t === 'channel' && i === 'chan-1'))
  // Both the bound channel's team and the agent's own configured team.
  assert.ok(pairs.some(([t, i]) => t === 'team' && i === 'team-1'))
  assert.ok(pairs.some(([t, i]) => t === 'team' && i === 'team-2'))
  assert.ok(pairs.some(([t, i]) => t === 'project' && i === 'proj-1'))
  assert.ok(pairs.some(([t, i]) => t === 'project' && i === 'proj-2'))
  assert.ok(pairs.some(([t, i]) => t === 'organization' && i === ORG))
  assert.ok(!pairs.some(([t]) => t === 'user'))
})
