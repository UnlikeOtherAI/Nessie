import assert from 'node:assert/strict'
import test from 'node:test'

import type { AppDetailRecord } from '@nessie/schemas'

import {
  agentAccessConsequence,
  agentAccessEmptyState,
  agentAccessHeadline,
  agentAccessToggleLabel,
  buildAgentAccessList,
  projectAppAccessTools,
  resolveAppAccessControl,
  type AppAccessPolicyTarget,
  type AppAccessToolInput,
} from '../src/components/features/apps/agent-access-view.js'

const detail = (overrides: Partial<AppDetailRecord> = {}): AppDetailRecord => ({
  agentsWithAccess: [], aliases: [], appSource: 'nessie', capabilities: { tools: [] },
  categories: ['development'], connectionCount: 1, connections: [], displayName: 'GitHub',
  distribution: 'remote', documentationUrl: null, featured: false, featuredOrder: null,
  iconUrl: null, id: 'app-1', locked: false, longDescription: null, managedByIntegration: false,
  name: 'github', primaryCategory: 'development', promptCount: null, repositoryUrl: null,
  resourceCount: null, shortDescription: 'Repositories, issues and pull requests.', slug: 'github',
  state: 'connected', tags: [], toolCount: 2, trustLevel: 'nessie', vendor: 'GitHub, Inc.',
  websiteUrl: null, ...overrides,
})

const tool = (overrides: Partial<AppAccessToolInput> = {}): AppAccessToolInput => ({
  enabled: true, id: 'entry-1', mcpInstanceId: 'conn-1', policyKey: 'entry-1',
  requiresExplicitGrant: true, status: 'active', ...overrides,
})
const openTool = (overrides: Partial<AppAccessToolInput> = {}): AppAccessToolInput =>
  tool({ requiresExplicitGrant: false, ...overrides })
const target = (overrides: Partial<AppAccessPolicyTarget> = {}): AppAccessPolicyTarget => ({
  agentKind: 'shared', id: 'agent-1', name: 'Research', role: 'Researcher', toolPolicy: {}, ...overrides,
})
const controlFor = (tools: AppAccessToolInput[]) => resolveAppAccessControl({
  canManage: true,
  connectionIds: ['conn-1'],
  projection: projectAppAccessTools(tools, ['conn-1']),
})

test('the empty message becomes a notice once there are switches to use', () => {
  const app = detail()
  const managed = buildAgentAccessList({
    agentsWithAccess: [], control: controlFor([tool()]), targets: [target()],
  })
  const observed = buildAgentAccessList({
    agentsWithAccess: [], control: { kind: 'owner-only' }, targets: [],
  })

  assert.equal(agentAccessEmptyState(app, managed)?.placement, 'notice')
  assert.equal(agentAccessEmptyState(app, observed)?.placement, 'sole')
  assert.equal(agentAccessEmptyState(app, buildAgentAccessList({
    agentsWithAccess: [], control: controlFor([tool()]),
    targets: [target({ toolPolicy: { 'entry-1': true } })],
  })), null)
})

test('"no agent can use this" is withheld when a row needs no grant', () => {
  const list = buildAgentAccessList({
    agentsWithAccess: [],
    control: controlFor([tool({ id: 'a', policyKey: 'a' }), openTool({ id: 'b', policyKey: 'b' })]),
    targets: [target()],
  })
  assert.equal(agentAccessEmptyState(detail(), list), null)
  assert.equal(agentAccessHeadline(list), '1 of 1 agents allowed to use this app')
})

test('the headline counts what the rows mean in each mode', () => {
  const managed = buildAgentAccessList({
    agentsWithAccess: [], control: controlFor([tool()]),
    targets: [target({ toolPolicy: { 'entry-1': true } }), target({ id: 'agent-2' })],
  })
  assert.equal(agentAccessHeadline(managed), '1 of 2 agents allowed to use this app')
  assert.equal(agentAccessHeadline(buildAgentAccessList({
    agentsWithAccess: [{ agentId: 'agent-3', name: 'Release Notes', role: null }],
    control: { kind: 'owner-only' }, targets: [],
  })), '1 agent can use this app')
})

test('the toggle label names the decision in both directions', () => {
  const [granted, none] = buildAgentAccessList({
    agentsWithAccess: [], control: controlFor([tool()]),
    targets: [target({ toolPolicy: { 'entry-1': true } }), target({ id: 'agent-2', name: 'Support' })],
  }).rows
  assert.ok(granted && none)
  assert.equal(agentAccessToggleLabel(none, 'GitHub'), 'Let Support use GitHub')
  assert.equal(agentAccessToggleLabel(granted, 'GitHub'), "Remove Research's access to GitHub")
})

test('the consequence line states what an unchecked row means', () => {
  const switchable = buildAgentAccessList({
    agentsWithAccess: [], control: controlFor([tool()]), targets: [target()],
  })
  const mixed = buildAgentAccessList({
    agentsWithAccess: [],
    control: controlFor([tool({ id: 'a', policyKey: 'a' }), openTool({ id: 'b', policyKey: 'b' })]),
    targets: [target()],
  })
  const observed = buildAgentAccessList({
    agentsWithAccess: [{ agentId: 'agent-3', name: 'Release Notes', role: null }],
    control: { kind: 'owner-only' }, targets: [],
  })
  assert.match(agentAccessConsequence(switchable), /cannot see or call this app at all/)
  assert.match(agentAccessConsequence(observed), /cannot see or call this app at all/)
  assert.match(agentAccessConsequence(mixed), /can still call the capabilities that need no grant/)
})
