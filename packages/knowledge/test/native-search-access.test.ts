import assert from 'node:assert/strict'
import test from 'node:test'

import {
  readableSpaceIdsSql,
  readableSpaceIdsSqlForAgent,
  readableSpaceIdsSqlForViewer,
} from '../src/native-search-access.js'
import type { SpaceViewer, SpaceViewerAgentScopes } from '../src/access.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const userId = '00000000-0000-4000-8000-000000000002'
const projectId = '00000000-0000-4000-8000-000000000003'
const agentId = '00000000-0000-4000-8000-000000000004'
const teamId = '00000000-0000-4000-8000-000000000005'
const channelId = '00000000-0000-4000-8000-000000000006'
const memberSpaceId = '00000000-0000-4000-8000-000000000007'
const parentAgentId = '00000000-0000-4000-8000-000000000008'

const viewer = (overrides: Partial<SpaceViewer> = {}): SpaceViewer => ({
  bypass: false,
  projectIds: new Set(),
  visibleAgentIds: new Set(),
  userId,
  ...overrides,
})

const agentScopes = (overrides: Partial<SpaceViewerAgentScopes> = {}): SpaceViewerAgentScopes => ({
  id: agentId,
  parentAgentId: null,
  orgBound: false,
  channelIds: new Set(),
  teamIds: new Set(),
  projectIds: new Set(),
  memberSpaceIds: new Set(),
  ...overrides,
})

test('readableSpaceIdsSql throws for a null-userId (bypass-only) viewer', () => {
  assert.throws(
    () => readableSpaceIdsSql(organizationId, viewer({ userId: null })),
    /requires a non-bypass viewer/,
  )
})

test('readableSpaceIdsSql includes the creator, org-visibility, and membership arms', () => {
  const fragment = readableSpaceIdsSql(organizationId, viewer())

  assert.match(fragment.sql, /s\.created_by = \?/)
  assert.match(fragment.sql, /s\.visibility = 'organization'::"ThoughtVisibility"/)
  assert.match(fragment.sql, /EXISTS \(\s*SELECT 1 FROM knowledge_space_members m/)
  assert.match(fragment.sql, /m\.user_id = \?::uuid/)
  assert.deepEqual(fragment.values, [organizationId, userId, userId, userId])
})

test('readableSpaceIdsSql binds visible agent ids and omits an empty owner arm', () => {
  const hidden = readableSpaceIdsSql(organizationId, viewer())
  assert.doesNotMatch(hidden.sql, /owner_agent_id = ANY/)

  const visible = readableSpaceIdsSql(
    organizationId,
    viewer({ visibleAgentIds: new Set([agentId]) }),
  )
  assert.match(
    visible.sql,
    /owner_agent_id IS NOT NULL\s*\n\s*AND s\.owner_agent_id = ANY\(\?::uuid\[\]\)/,
  )
  assert.deepEqual(visible.values, [organizationId, userId, [agentId], userId, userId])
})

test('readableSpaceIdsSql binds pre-resolved visible agent ids only when non-empty', () => {
  const empty = readableSpaceIdsSql(organizationId, viewer())
  assert.doesNotMatch(empty.sql, /owner_agent_id = ANY/)

  const fragment = readableSpaceIdsSql(
    organizationId,
    viewer({ visibleAgentIds: new Set([agentId]) }),
  )
  assert.match(fragment.sql, /s\.owner_agent_id IS NOT NULL/)
  assert.match(fragment.sql, /s\.owner_agent_id = ANY\(\?::uuid\[\]\)/)
  assert.ok(fragment.values.includes(agentId) === false)
  assert.ok(fragment.values.some((value) => Array.isArray(value) && value[0] === agentId))
})

test('readableSpaceIdsSql omits the project-visibility arm when projectIds is empty', () => {
  const fragment = readableSpaceIdsSql(organizationId, viewer())
  assert.doesNotMatch(fragment.sql, /project_id IN/)
})

test('readableSpaceIdsSql adds the project-visibility arm when projectIds is non-empty', () => {
  const fragment = readableSpaceIdsSql(
    organizationId,
    viewer({ projectIds: new Set([projectId]) }),
  )

  assert.match(
    fragment.sql,
    /visibility = 'project'::"ThoughtVisibility"\s*\n\s*AND s\.project_id IN \(\?::uuid\)/,
  )
  assert.deepEqual(fragment.values, [organizationId, userId, userId, projectId, userId])
})

test('readableSpaceIdsSqlForAgent always excludes restricted spaces', () => {
  const fragment = readableSpaceIdsSqlForAgent(organizationId, agentScopes())
  assert.match(fragment.sql, /s\.sensitivity_tier <> 'restricted'::"SensitivityTier"/)
})

test('readableSpaceIdsSqlForAgent includes the private-to-agent and creator arms unconditionally', () => {
  const fragment = readableSpaceIdsSqlForAgent(organizationId, agentScopes())
  assert.match(fragment.sql, /s\.private_to_agent_id = \?::uuid/)
  assert.match(fragment.sql, /s\.created_by = \?/)
  assert.deepEqual(fragment.values, [organizationId, agentId, agentId, [agentId]])
})

test('readableSpaceIdsSqlForAgent binds the owning agent and parent as explicit grants', () => {
  const fragment = readableSpaceIdsSqlForAgent(
    organizationId,
    agentScopes({ parentAgentId }),
  )
  assert.match(fragment.sql, /s\.owner_agent_id = ANY\(\?::uuid\[\]\)/)
  assert.deepEqual(
    fragment.values,
    [organizationId, agentId, agentId, [agentId, parentAgentId]],
  )
})

test('readableSpaceIdsSqlForAgent omits every scoped arm when the agent has no reach', () => {
  const fragment = readableSpaceIdsSqlForAgent(organizationId, agentScopes())
  assert.doesNotMatch(fragment.sql, /s\.id IN/)
  assert.doesNotMatch(fragment.sql, /'organization'::"ThoughtVisibility"/)
  assert.doesNotMatch(fragment.sql, /'project'::"ThoughtVisibility"/)
  assert.doesNotMatch(fragment.sql, /'team'::"ThoughtVisibility"/)
  assert.doesNotMatch(fragment.sql, /'channel'::"ThoughtVisibility"/)
})

test('readableSpaceIdsSqlForAgent adds the organization arm only when orgBound', () => {
  assert.match(
    readableSpaceIdsSqlForAgent(organizationId, agentScopes({ orgBound: true })).sql,
    /'organization'::"ThoughtVisibility"/,
  )
  assert.doesNotMatch(
    readableSpaceIdsSqlForAgent(organizationId, agentScopes({ orgBound: false })).sql,
    /'organization'::"ThoughtVisibility"/,
  )
})

test('readableSpaceIdsSqlForAgent adds the member-space arm only when memberSpaceIds is non-empty', () => {
  const fragment = readableSpaceIdsSqlForAgent(
    organizationId,
    agentScopes({ memberSpaceIds: new Set([memberSpaceId]) }),
  )
  assert.match(fragment.sql, /s\.id IN \(\?::uuid\)/)
  assert.deepEqual(
    fragment.values,
    [organizationId, agentId, agentId, [agentId], memberSpaceId],
  )
})

test('readableSpaceIdsSqlForAgent adds the project/team/channel arms only when the agent reaches them', () => {
  const fragment = readableSpaceIdsSqlForAgent(
    organizationId,
    agentScopes({
      projectIds: new Set([projectId]),
      teamIds: new Set([teamId]),
      channelIds: new Set([channelId]),
    }),
  )
  assert.match(
    fragment.sql,
    /'project'::"ThoughtVisibility"\s*\n\s*AND s\.project_id IN \(\?::uuid\)/,
  )
  assert.match(
    fragment.sql,
    /'team'::"ThoughtVisibility"\s*\n\s*AND s\.team_id IN \(\?::uuid\)/,
  )
  assert.match(
    fragment.sql,
    /'channel'::"ThoughtVisibility"\s*\n\s*AND s\.channel_id IN \(\?::uuid\)/,
  )
})

test('readableSpaceIdsSqlForViewer picks the user fragment for a plain user viewer', () => {
  const fragment = readableSpaceIdsSqlForViewer(organizationId, viewer())
  assert.match(fragment?.sql ?? '', /knowledge_space_members/)
})

test('readableSpaceIdsSqlForViewer picks the agent fragment for an agent viewer', () => {
  const fragment = readableSpaceIdsSqlForViewer(
    organizationId,
    {
      bypass: false,
      userId: null,
      projectIds: new Set(),
      visibleAgentIds: new Set(),
      agent: agentScopes(),
    },
  )
  assert.match(fragment?.sql ?? '', /sensitivity_tier <> 'restricted'/)
})

test('readableSpaceIdsSqlForViewer returns null (no filter) for a bypass viewer', () => {
  const fragment = readableSpaceIdsSqlForViewer(
    organizationId,
    {
      bypass: true,
      userId: null,
      projectIds: new Set(),
      visibleAgentIds: new Set(),
    },
  )
  assert.equal(fragment, null)
})
