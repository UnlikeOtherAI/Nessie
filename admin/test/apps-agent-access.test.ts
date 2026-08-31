import assert from 'node:assert/strict'
import test from 'node:test'

import type { AppConnectionSummaryRecord, AppDetailRecord } from '@nessie/schemas'

import {
  agentAccessConsequence,
  agentAccessEmptyState,
  agentAccessHeadline,
  agentAccessToggleLabel,
  agentAccessWriteFailure,
  appAccessNotice,
  beginAgentAccessWrite,
  buildAgentAccessList,
  previewAgentAccessRow,
  projectAppAccessTools,
  resolveAgentAccessRow,
  resolveAppAccessControl,
  type AppAccessPolicyTarget,
  type AppAccessToolInput,
} from '../src/components/features/apps/agent-access-view.js'

/**
 * `Agent.toolPolicy` plus the connection's install scope is all that decides
 * what an agent may call (`worker/src/run/mcp-toolset.ts` `isExposed`). These
 * tests pin the row model that renders it — above all, the places where a
 * switch would otherwise disagree with the data underneath it.
 */

const connection: AppConnectionSummaryRecord = {
  displayName: 'Work',
  errorMessage: null,
  id: 'conn-1',
  lastConnectedAt: '2026-08-01T00:00:00.000Z',
  scopeId: '00000000-0000-4000-8000-000000000001',
  scopeType: 'team',
  status: 'connected',
}

const detail = (overrides: Partial<AppDetailRecord> = {}): AppDetailRecord => ({
  agentsWithAccess: [],
  aliases: [],
  appSource: 'nessie',
  capabilities: { tools: [] },
  categories: ['development'],
  connectionCount: 1,
  connections: [connection],
  displayName: 'GitHub',
  distribution: 'remote',
  documentationUrl: null,
  featured: false,
  featuredOrder: null,
  iconUrl: null,
  id: 'app-1',
  locked: false,
  longDescription: null,
  managedByIntegration: false,
  name: 'github',
  primaryCategory: 'development',
  promptCount: null,
  repositoryUrl: null,
  resourceCount: null,
  shortDescription: 'Repositories, issues and pull requests.',
  slug: 'github',
  state: 'connected',
  tags: [],
  toolCount: 2,
  trustLevel: 'nessie',
  vendor: 'GitHub, Inc.',
  websiteUrl: null,
  ...overrides,
})

/**
 * The default is an App-Store-connected row: those project with
 * `metadata.requiresExplicitGrant`, which is what makes them switchable.
 */
const tool = (overrides: Partial<AppAccessToolInput> = {}): AppAccessToolInput => ({
  enabled: true,
  id: 'entry-1',
  mcpInstanceId: 'conn-1',
  policyKey: 'entry-1',
  requiresExplicitGrant: true,
  status: 'active',
  ...overrides,
})

/** A row from a connection made the older way: exposed by scope, not by grant. */
const openTool = (overrides: Partial<AppAccessToolInput> = {}): AppAccessToolInput =>
  tool({ requiresExplicitGrant: false, ...overrides })

const target = (
  overrides: Partial<AppAccessPolicyTarget> = {},
): AppAccessPolicyTarget => ({
  agentKind: 'shared',
  id: 'agent-1',
  name: 'Research',
  role: 'Researcher',
  toolPolicy: {},
  ...overrides,
})

const controlFor = (tools: AppAccessToolInput[], connectionIds = ['conn-1']) =>
  resolveAppAccessControl({
    canManage: true,
    connectionIds,
    projection: projectAppAccessTools(tools, connectionIds),
  })

// ─── Which rows are even callable ───────────────────────────────────────────

test('only enabled, active rows of this app\'s own connections are callable', () => {
  const projection = projectAppAccessTools(
    [
      tool({ id: 'a', policyKey: 'a' }),
      tool({ id: 'b', policyKey: 'b', status: 'pending_review' }),
      tool({ id: 'c', policyKey: 'c', enabled: false }),
      tool({ id: 'other', mcpInstanceId: 'conn-9', policyKey: 'other' }),
      tool({ id: 'builtin', mcpInstanceId: null, policyKey: 'web_search' }),
    ],
    ['conn-1'],
  )

  assert.deepEqual(projection.grantable, [{ policyKey: 'a', registryEntryId: 'a' }])
  assert.deepEqual(projection.open, [])
  // Rows belonging to another app are not this app's business at all, so they
  // are neither callable nor counted as waiting.
  assert.equal(projection.waiting, 2)
})

test('callable rows split by whether the write route would take them', () => {
  const projection = projectAppAccessTools(
    [tool({ id: 'a', policyKey: 'a' }), openTool({ id: 'b', policyKey: 'b' })],
    ['conn-1'],
  )

  assert.deepEqual(projection.grantable, [{ policyKey: 'a', registryEntryId: 'a' }])
  assert.deepEqual(projection.open, [{ policyKey: 'b', registryEntryId: 'b' }])
})

test('the write id and the read key stay separate fields', () => {
  const projection = projectAppAccessTools(
    [tool({ id: 'entry-7', policyKey: 'deep_water_run_update' })],
    ['conn-1'],
  )

  assert.deepEqual(projection.grantable, [
    { policyKey: 'deep_water_run_update', registryEntryId: 'entry-7' },
  ])
})

// ─── When a switch may honestly be offered ──────────────────────────────────

test('an app whose rows all take an explicit grant is switchable', () => {
  const control = controlFor([tool()])

  assert.equal(control.kind, 'manageable')
  // Nothing is unaccounted for, so the notice stays silent.
  assert.equal(appAccessNotice(control, () => '/agents/tools'), null)
})

test('one grantable row still earns the switch, and the rest are disclosed', () => {
  const control = controlFor([
    tool({ id: 'a', policyKey: 'a' }),
    openTool({ id: 'b', policyKey: 'b' }),
    openTool({ id: 'c', policyKey: 'c' }),
  ])
  assert.equal(control.kind, 'manageable')
  assert.equal(control.kind === 'manageable' && control.tools.length, 1)

  // Withdrawing the control over rows nothing can revoke would lose a real
  // decision; claiming it covers them would claim a write the route refuses.
  const notice = appAccessNotice(control, () => '/agents/tools')
  assert.match(String(notice?.body), /^2 of this app's capabilities need no per-agent grant/)
  assert.match(String(notice?.body), /cover the other 1\./)
})

test('an app with no grantable row at all is read-only, and says why', () => {
  const control = controlFor([
    openTool({ id: 'a', policyKey: 'a' }),
    openTool({ id: 'b', policyKey: 'b' }),
  ])

  assert.equal(control.kind, 'open-to-everyone')
  const notice = appAccessNotice(control, () => '/agents/tools')
  assert.match(String(notice?.body), /This app's 2 capabilities need no per-agent grant/)
  assert.match(String(notice?.body), /cannot be given one agent at a time/)
  assert.equal(notice?.href, null)
})

test('unreadable capability rows are not the same answer as none', () => {
  const member = resolveAppAccessControl({
    canManage: false,
    connectionIds: ['conn-1'],
    projection: null,
  })
  const ownerWithNothing = resolveAppAccessControl({
    canManage: true,
    connectionIds: ['conn-1'],
    projection: { grantable: [], open: [], waiting: 0, waitingConnectionId: null },
  })

  assert.equal(member.kind, 'owner-only')
  assert.equal(ownerWithNothing.kind, 'no-capabilities')
})

test('capabilities nobody has reviewed point at the connection holding them', () => {
  const control = controlFor(
    [tool({ mcpInstanceId: 'conn-2', status: 'pending_review' })],
    ['conn-1', 'conn-2'],
  )
  assert.equal(control.kind, 'awaiting-review')

  // The waiting rows are on the second account, so pointing at the first would
  // open a filtered list with nothing in it.
  const notice = appAccessNotice(control, (id) => `/agents/tools?instance=${id}`)
  assert.equal(notice?.href, '/agents/tools?instance=conn-2')
})

test('a disconnected app offers no control and no notice', () => {
  const control = resolveAppAccessControl({
    canManage: true,
    connectionIds: [],
    projection: { grantable: [], open: [], waiting: 3, waitingConnectionId: 'conn-1' },
  })

  assert.equal(control.kind, 'not-connected')
  // "You have not connected it" is the empty state's job; a notice that names
  // no next action is cut.
  assert.equal(appAccessNotice(control, () => '/agents/tools'), null)
})

// ─── Rows ───────────────────────────────────────────────────────────────────

test('the managed roster is everyone editable, not only who already has access', () => {
  const list = buildAgentAccessList({
    agentsWithAccess: [{ agentId: 'agent-1', name: 'Research', role: 'Researcher' }],
    control: controlFor([tool()]),
    targets: [
      target({ toolPolicy: { 'entry-1': true } }),
      target({ id: 'agent-2', name: 'Support' }),
    ],
  })

  assert.equal(list.mode, 'managed')
  assert.deepEqual(list.rows.map((row) => row.state), ['granted', 'none'])
  assert.equal(list.rows[0]?.summary, 'Can use the one capability')
  assert.equal(list.rows[1]?.summary, 'No access')
})

test('a half-granted app reads as partial rather than rounding to on', () => {
  const tools = [tool({ id: 'a', policyKey: 'a' }), tool({ id: 'b', policyKey: 'b' })]
  const list = buildAgentAccessList({
    agentsWithAccess: [{ agentId: 'agent-1', name: 'Research', role: 'Researcher' }],
    control: controlFor(tools),
    targets: [target({ toolPolicy: { a: true } })],
  })

  assert.equal(list.rows[0]?.state, 'partial')
  assert.equal(list.rows[0]?.summary, 'Can use 1 of 2 capabilities')
})

test('an ungranted row counts the capabilities it reaches without a grant', () => {
  const list = buildAgentAccessList({
    agentsWithAccess: [{ agentId: 'agent-1', name: 'Research', role: 'Researcher' }],
    control: controlFor([
      tool({ id: 'a', policyKey: 'a' }),
      openTool({ id: 'b', policyKey: 'b' }),
      openTool({ id: 'c', policyKey: 'c' }),
    ]),
    targets: [target()],
  })

  // The switch is off, but "No access" would be a flat lie about two rows the
  // agent can already call.
  assert.equal(list.rows[0]?.state, 'none')
  assert.equal(list.rows[0]?.summary, 'Can use 2 of 3 capabilities · 2 need no grant')
})

test('a denial written elsewhere is subtracted from what needs no grant', () => {
  const list = buildAgentAccessList({
    agentsWithAccess: [],
    control: controlFor([
      tool({ id: 'a', policyKey: 'a' }),
      openTool({ id: 'b', policyKey: 'b' }),
      openTool({ id: 'c', policyKey: 'c' }),
    ]),
    // `false` on a row needing no grant is the Agent Designer's write, and the
    // worker honours it — counting it as usable would overstate the row.
    targets: [target({ toolPolicy: { a: true, b: false } })],
  })

  assert.equal(list.rows[0]?.state, 'granted')
  assert.equal(list.rows[0]?.summary, 'Can use 2 of 3 capabilities · 2 need no grant')
})

test('a grant the install scope does not reach says so on the row', () => {
  const list = buildAgentAccessList({
    // The server computed access with scope AND policy; this agent is absent
    // from it, so the allow alone is not access.
    agentsWithAccess: [],
    control: controlFor([tool()]),
    targets: [target({ toolPolicy: { 'entry-1': true } })],
  })

  assert.equal(list.rows[0]?.state, 'granted')
  assert.equal(list.rows[0]?.hasAccess, false)
  assert.match(String(list.rows[0]?.note), /no connected account reaches this agent/)
})

test('a row with no grant carries no note', () => {
  const list = buildAgentAccessList({
    agentsWithAccess: [],
    control: controlFor([tool()]),
    targets: [target()],
  })

  assert.equal(list.rows[0]?.note, null)
})

test('without a switch the list is the server\'s own answer', () => {
  const list = buildAgentAccessList({
    agentsWithAccess: [{ agentId: 'agent-3', name: 'Release Notes', role: null }],
    control: { kind: 'owner-only' },
    targets: [target({ id: 'agent-9', name: 'Never rendered' })],
  })

  assert.equal(list.mode, 'observed')
  assert.deepEqual(list.rows.map((row) => row.agentId), ['agent-3'])
  assert.equal(list.rows[0]?.summary, 'Can use this app')
})

// ─── Optimistic write and rollback ──────────────────────────────────────────

test('an in-flight switch predicts the grant but never predicts reach', () => {
  const [row] = buildAgentAccessList({
    agentsWithAccess: [],
    control: controlFor([tool({ id: 'a', policyKey: 'a' }), tool({ id: 'b', policyKey: 'b' })]),
    targets: [target({ toolPolicy: { a: true } })],
  }).rows
  assert.ok(row)

  const preview = previewAgentAccessRow(row, true)
  assert.equal(preview.state, 'granted')
  assert.equal(preview.summary, 'Can use all 2 capabilities')
  // Whether the connection reaches this agent is the server's answer; guessing
  // it here would put a claim on screen the refetch might contradict.
  assert.equal(preview.note, null)
  assert.equal(previewAgentAccessRow(row, false).state, 'none')
})

test('a switch never predicts the rows it does not write', () => {
  const [row] = buildAgentAccessList({
    agentsWithAccess: [],
    control: controlFor([
      tool({ id: 'a', policyKey: 'a' }),
      openTool({ id: 'b', policyKey: 'b' }),
    ]),
    targets: [target()],
  }).rows
  assert.ok(row)

  // Turning the switch off leaves the ungranted row exactly where it was, so
  // the count may not fall to zero.
  const off = previewAgentAccessRow(row, false)
  assert.equal(off.summary, 'Can use 1 of 2 capabilities · 1 need no grant')
  assert.equal(previewAgentAccessRow(row, true).summary,
    'Can use 2 of 2 capabilities · 1 need no grant')
})

test('the preview stands only while the server still says what it said', () => {
  const [row] = buildAgentAccessList({
    agentsWithAccess: [],
    control: controlFor([tool()]),
    targets: [target()],
  }).rows
  assert.ok(row)

  const pending = beginAgentAccessWrite(row, true)
  assert.equal(resolveAgentAccessRow(row, pending).state, 'granted')

  // The refetch lands: the server row wins, with no effect and no flicker back
  // through the old value.
  const refetched = { ...row, state: 'granted' as const, grantedCount: 1 }
  assert.equal(resolveAgentAccessRow(refetched, pending), refetched)

  // A later change by somebody else also wins over the stale preview.
  const revokedElsewhere = { ...row, state: 'none' as const }
  assert.equal(resolveAgentAccessRow(revokedElsewhere, null), revokedElsewhere)
})

test('a fan-out that stops part way says how far it got', () => {
  assert.equal(
    agentAccessWriteFailure({ landed: 0, reason: 'Request failed.', total: 42 }),
    'Request failed.',
  )
  assert.match(
    agentAccessWriteFailure({ landed: 7, reason: 'Request failed.', total: 42 }),
    /Only 7 of 42 capabilities changed/,
  )
})

// ─── Copy ───────────────────────────────────────────────────────────────────

test('the empty message becomes a notice once there are switches to use', () => {
  const app = detail()
  const managed = buildAgentAccessList({
    agentsWithAccess: [],
    control: controlFor([tool()]),
    targets: [target()],
  })
  const observed = buildAgentAccessList({
    agentsWithAccess: [],
    control: { kind: 'owner-only' },
    targets: [],
  })

  assert.equal(agentAccessEmptyState(app, managed)?.placement, 'notice')
  assert.equal(agentAccessEmptyState(app, observed)?.placement, 'sole')
  assert.equal(
    agentAccessEmptyState(app, buildAgentAccessList({
      agentsWithAccess: [],
      control: controlFor([tool()]),
      targets: [target({ toolPolicy: { 'entry-1': true } })],
    })),
    null,
  )
})

test('"no agent can use this" is withheld when a row needs no grant', () => {
  const list = buildAgentAccessList({
    agentsWithAccess: [],
    control: controlFor([
      tool({ id: 'a', policyKey: 'a' }),
      openTool({ id: 'b', policyKey: 'b' }),
    ]),
    targets: [target()],
  })

  assert.equal(agentAccessEmptyState(detail(), list), null)
  assert.equal(agentAccessHeadline(list), '1 of 1 agents allowed to use this app')
})

test('the headline counts what the rows mean in each mode', () => {
  const managed = buildAgentAccessList({
    agentsWithAccess: [],
    control: controlFor([tool()]),
    targets: [target({ toolPolicy: { 'entry-1': true } }), target({ id: 'agent-2' })],
  })

  assert.equal(agentAccessHeadline(managed), '1 of 2 agents allowed to use this app')
  assert.equal(
    agentAccessHeadline(buildAgentAccessList({
      agentsWithAccess: [{ agentId: 'agent-3', name: 'Release Notes', role: null }],
      control: { kind: 'owner-only' },
      targets: [],
    })),
    '1 agent can use this app',
  )
})

test('the toggle label names the decision in both directions', () => {
  const [granted, none] = buildAgentAccessList({
    agentsWithAccess: [],
    control: controlFor([tool()]),
    targets: [target({ toolPolicy: { 'entry-1': true } }), target({ id: 'agent-2', name: 'Support' })],
  }).rows
  assert.ok(granted && none)

  assert.equal(agentAccessToggleLabel(none, 'GitHub'), 'Let Support use GitHub')
  assert.equal(agentAccessToggleLabel(granted, 'GitHub'), "Remove Research's access to GitHub")
})

test('the consequence line states what an unchecked row means', () => {
  const switchable = buildAgentAccessList({
    agentsWithAccess: [],
    control: controlFor([tool()]),
    targets: [target()],
  })
  const mixed = buildAgentAccessList({
    agentsWithAccess: [],
    control: controlFor([
      tool({ id: 'a', policyKey: 'a' }),
      openTool({ id: 'b', policyKey: 'b' }),
    ]),
    targets: [target()],
  })
  const observed = buildAgentAccessList({
    agentsWithAccess: [{ agentId: 'agent-3', name: 'Release Notes', role: null }],
    control: { kind: 'owner-only' },
    targets: [],
  })

  assert.match(agentAccessConsequence(switchable), /cannot see or call this app at all/)
  assert.match(agentAccessConsequence(observed), /cannot see or call this app at all/)
  // The reassuring version would be false here, so it is not offered.
  assert.match(agentAccessConsequence(mixed), /can still call the capabilities that need no grant/)
})
