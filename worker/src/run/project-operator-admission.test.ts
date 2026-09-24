import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BUILTIN_TOOL_DEFINITIONS,
  BUILTIN_TOOL_IDS,
  findProtectedExplicitToolPolicyKeys,
  PROJECT_OPERATOR_CAPABILITY_ID,
  PROJECT_OPERATOR_TOOL_IDS,
  SYSTEM_TOOL_DEFINITIONS,
} from '@nessie/runtime'
import { TICKET_WORK_PURPOSE } from '@nessie/schemas'

import {
  isLiveRequesterRun,
  resolveProjectOperatorToolIds,
  type LiveRequesterRunFacts,
} from './project-operator-admission.js'
import { authorizeToolCall, resolveAgentTools } from './tool-policy.js'

/**
 * The project-operator arm, pinned without a database: which runs are a live
 * requester's, what the grant opens, and that the gate admits operator verbs on
 * that arm alone. The live-row half — each verb acting as the requester — is
 * `worker/test/db/project-operator.test.ts`.
 */

const PERSON = '00000000-0000-4000-8000-000000000001'

// A person's own turn with an ordinary shared agent in a project room.
const live: LiveRequesterRunFacts = {
  actorId: PERSON,
  actorType: 'user',
  agentKind: 'shared',
  channel: { dmKey: null, systemChannelType: null },
  effectiveUserId: null,
  interactive: true,
  parentAgentId: null,
  purpose: undefined,
  systemManaged: false,
  systemSlug: null,
}

test('a person\'s own turn in a project room is a live-requester run', () => {
  assert.equal(isLiveRequesterRun(live), true)
  // The run may carry the person as its effective user, as a stamped wake does.
  assert.equal(isLiveRequesterRun({ ...live, effectiveUserId: PERSON }), true)
})

test('no unattended or borrowed run is a live-requester run', () => {
  const refused: Array<[string, Partial<LiveRequesterRunFacts>]> = [
    // A trigger fire acts as the agent, not a person.
    ['a trigger fire', { actorType: 'agent', actorId: '00000000-0000-4000-8000-0000000000aa' }],
    // A scheduled fire reconstructs its creator as the effective user, but
    // nobody is there: it is never interactive.
    ['a scheduled fire', { actorType: 'agent', effectiveUserId: PERSON, interactive: false }],
    ['a non-interactive user turn', { interactive: false }],
    ['ticket work', { purpose: TICKET_WORK_PURPOSE }],
    ['a peer delegation', { purpose: 'agent.peer_delegation' }],
    ['channel-policy work', { purpose: 'channel.policy' }],
    ['a global-agent brief', { purpose: 'global_agent.brief' }],
    ['another person\'s identity riding along', { effectiveUserId: '00000000-0000-4000-8000-000000000002' }],
    ['the Personal Assistant', { agentKind: 'personal_assistant' }],
    ['a system-managed agent', { systemManaged: true }],
    ['a global agent', { systemSlug: 'agent-designer' }],
    ['a spawned child', { parentAgentId: '00000000-0000-4000-8000-0000000000bb' }],
    ['a system conversation', { channel: { systemChannelType: 'system_agent' } }],
    ['a direct message', { channel: { dmKey: 'dm:a:b' } }],
  ]
  for (const [name, override] of refused) {
    assert.equal(isLiveRequesterRun({ ...live, ...override }), false, name)
  }
})

test('the grant opens every operator verb, and only a bound, enabled, live run holds it', () => {
  const granted = { [PROJECT_OPERATOR_CAPABILITY_ID]: true }
  assert.deepEqual(
    [...resolveProjectOperatorToolIds({ bound: true, capabilityEnabled: true, live: true, toolPolicy: granted })],
    [...PROJECT_OPERATOR_TOOL_IDS],
  )
  for (const [name, input] of [
    ['no grant', { bound: true, capabilityEnabled: true, live: true, toolPolicy: {} }],
    ['a revoked grant', { bound: true, capabilityEnabled: true, live: true, toolPolicy: { [PROJECT_OPERATOR_CAPABILITY_ID]: false } }],
    ['not bound to the channel', { bound: false, capabilityEnabled: true, live: true, toolPolicy: granted }],
    ['switched off for the organisation', { bound: true, capabilityEnabled: false, live: true, toolPolicy: granted }],
    ['not a live-requester run', { bound: true, capabilityEnabled: true, live: false, toolPolicy: granted }],
  ] as const) {
    assert.equal(resolveProjectOperatorToolIds(input).size, 0, name)
  }
})

test('the operator verbs are the plan\'s set, and the capability is a grant, never a tool', () => {
  assert.deepEqual([...PROJECT_OPERATOR_TOOL_IDS].sort(), [
    'agent_trigger_create', 'agent_trigger_update', 'channel_create', 'kb_space_create',
    'project_create', 'project_list', 'team_create', 'ticket_board_column_create',
    'ticket_board_column_update', 'ticket_board_create', 'ticket_label_create', 'workflow_create',
    'workflow_install', 'workflow_run', 'workflow_trigger_create', 'workflow_update',
  ])
  // Project membership is never in it.
  for (const id of ['agent_bind_channel', 'agent_unbind_channel', 'channel_join', 'pa_join_channel']) {
    assert.equal(PROJECT_OPERATOR_TOOL_IDS.has(id), false, id)
  }
  // Registered and protected like an explicit grant, offered to no model.
  const capability = SYSTEM_TOOL_DEFINITIONS.find((tool) => tool.id === PROJECT_OPERATOR_CAPABILITY_ID)
  assert.equal(capability?.requiresExplicitGrant, true)
  assert.equal(BUILTIN_TOOL_IDS.has(PROJECT_OPERATOR_CAPABILITY_ID), false)
  // Every operator verb acts as a person, so it is PA-only apart from this arm.
  for (const tool of BUILTIN_TOOL_DEFINITIONS.filter((definition) => definition.projectOperator)) {
    assert.equal(tool.personalAssistantOnly, true, tool.id)
  }
})

test('a generic agent write can never grant project_operator', async () => {
  // No registry uuid is named, so the gate reads nothing from the database.
  const prisma = {} as Parameters<typeof findProtectedExplicitToolPolicyKeys>[0]
  const protectedKeys = await findProtectedExplicitToolPolicyKeys(prisma, {
    [PROJECT_OPERATOR_CAPABILITY_ID]: true,
    web_search: true,
  })
  assert.deepEqual([...protectedKeys], [PROJECT_OPERATOR_CAPABILITY_ID])
})

const allEnabled = new Set(BUILTIN_TOOL_DEFINITIONS.map((tool) => tool.id))
const allowed = (
  toolId: string,
  options: Parameters<typeof authorizeToolCall>[6],
  policy: Record<string, boolean> | null = null,
) =>
  authorizeToolCall(toolId, allEnabled, BUILTIN_TOOL_DEFINITIONS, policy, null, 'shared', options).allowed

test('the gate admits an operator verb to a shared agent on the operator arm alone', () => {
  const operator = { projectOperatorToolIds: PROJECT_OPERATOR_TOOL_IDS }
  for (const toolId of ['project_create', 'channel_create', 'workflow_trigger_create', 'kb_space_create']) {
    assert.equal(allowed(toolId, operator), true, toolId)
    assert.equal(allowed(toolId, {}), false, `${toolId} without the arm`)
  }
  // `ticket_board_create` is an explicit grant of its own; on the operator arm
  // the `project_operator` grant stands for it, on no other arm.
  assert.equal(allowed('ticket_board_create', operator), true)
  assert.equal(allowed('ticket_board_create', {}), false)
  // The arm opens operator verbs only: other act-as-user tools stay shut.
  for (const toolId of ['agent_create', 'agent_bind_channel', 'send_message', 'agent_trigger_delete']) {
    assert.equal(allowed(toolId, operator), false, toolId)
  }
  // An explicit deny still wins.
  assert.equal(allowed('project_create', operator, { project_create: false }), false)
})

test('a shared agent without the arm is offered no workflow write, and keeps the reads', () => {
  const offered = resolveAgentTools(allEnabled, BUILTIN_TOOL_DEFINITIONS, null, null, 'shared').allowedIds
  for (const toolId of ['workflow_create', 'workflow_update', 'workflow_install', 'workflow_trigger_create', 'workflow_run']) {
    assert.equal(offered.has(toolId), false, toolId)
  }
  for (const toolId of ['workflow_list', 'workflow_preview', 'workflow_run_status']) {
    assert.equal(offered.has(toolId), true, toolId)
  }
  const operatorRun = resolveAgentTools(allEnabled, BUILTIN_TOOL_DEFINITIONS, null, null, 'shared', {
    projectOperatorToolIds: PROJECT_OPERATOR_TOOL_IDS,
  })
  for (const toolId of PROJECT_OPERATOR_TOOL_IDS) assert.equal(operatorRun.allowedIds.has(toolId), true, toolId)
})

test('the Personal Assistant keeps the workflow verbs on its own arm', () => {
  const offered = resolveAgentTools(allEnabled, BUILTIN_TOOL_DEFINITIONS, null, null, 'personal_assistant').allowedIds
  for (const toolId of ['workflow_create', 'workflow_install', 'workflow_trigger_create', 'workflow_run']) {
    assert.equal(offered.has(toolId), true, toolId)
  }
})
