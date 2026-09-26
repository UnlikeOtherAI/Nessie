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
  isPersonsOwnTurn,
  liveTurnDenialMessage,
  PROJECT_OPERATOR_LIVE_TURN_REFUSAL,
  projectOperatorRefusal,
  type LiveRequesterRunFacts,
  type ProjectOperatorFacts,
  type RequesterMessage,
} from './project-operator-admission.js'
import { authorizeToolCall, resolveAgentTools } from './tool-policy.js'

/**
 * The project-operator arm, pinned without a database: which runs are a live
 * requester's, which turns are the person's own, what the grant opens, and
 * that the gate admits operator verbs on that arm alone. The live-row half —
 * each verb acting as the requester, each refused shape through the real
 * loader — is `worker/test/db/project-operator.test.ts`.
 */

const PERSON = '00000000-0000-4000-8000-000000000001'
const OTHER = '00000000-0000-4000-8000-000000000002'
const THREAD = '00000000-0000-4000-8000-0000000000f1'
const MESSAGE = '00000000-0000-4000-8000-0000000000e1'

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
    ['a worker continuation of a long turn', { interactive: false }],
    ['ticket work', { purpose: TICKET_WORK_PURPOSE }],
    ['a peer delegation', { purpose: 'agent.peer_delegation' }],
    ['channel-policy work', { purpose: 'channel.policy' }],
    ['a global-agent brief', { purpose: 'global_agent.brief' }],
    ['another person\'s identity riding along', { effectiveUserId: OTHER }],
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

const composed = (overrides: Partial<RequesterMessage> = {}): RequesterMessage => ({
  deletedAt: null,
  id: MESSAGE,
  metadata: { authorship: 'person' },
  role: 'user',
  threadId: THREAD,
  userId: PERSON,
  ...overrides,
})
const firstRun = { continuationOfRunId: null, restartOfRunId: null, triggerMessageId: MESSAGE }
const turn = (overrides: Partial<Parameters<typeof isPersonsOwnTurn>[0]> = {}) => isPersonsOwnTurn({
  actorId: PERSON,
  messageId: MESSAGE,
  messages: [composed()],
  run: firstRun,
  threadId: THREAD,
  ...overrides,
})

test('a turn is the person\'s own only when every message it answers is theirs, and any replay was their press', () => {
  assert.equal(turn(), true)
  const BATCHED = '00000000-0000-4000-8000-0000000000e2'
  const refused: Array<[string, Partial<Parameters<typeof isPersonsOwnTurn>[0]>]> = [
    // A Restart of a webhook, cron or ticket-work run replays its kickoff.
    ['a replayed server kickoff', { messages: [composed({ metadata: {}, role: 'system', userId: null })] }],
    // A Restart or Continue by B of A's run: B is the actor, A wrote the input.
    ['somebody else\'s message replayed', { messages: [composed({ userId: OTHER })] }],
    ['a relayed post', { messages: [composed({ metadata: { delegatedByAgentId: 'pa' } })] }],
    ['a deleted message', { messages: [composed({ deletedAt: new Date() })] }],
    ['a message from another conversation', { messages: [composed({ threadId: 'another-thread' })] }],
    ['a job naming a message the run was not started on', { run: { ...firstRun, triggerMessageId: BATCHED } }],
    ['no run row', { run: null }],
    // A card or approval somebody else answered resumes as the parked actor.
    ['a continuation somebody else pressed', {
      resumedByUserId: OTHER, run: { ...firstRun, continuationOfRunId: 'parked' },
    }],
    ['a continuation that names no presser', { run: { ...firstRun, continuationOfRunId: 'parked' } }],
    ['a restart that names no presser', { run: { ...firstRun, restartOfRunId: 'failed' } }],
    // A drain takes the latest person's actor and folds in others' messages.
    ['a drain that folded in another member\'s message', {
      batchMessageIds: [BATCHED, MESSAGE],
      messages: [composed(), composed({ id: BATCHED, userId: OTHER })],
    }],
    ['a drain whose batch does not include its own trigger', { batchMessageIds: [BATCHED] }],
  ]
  for (const [name, override] of refused) assert.equal(turn(override), false, name)
  // The person's own press of their own turn is theirs, and so is a drain of theirs.
  assert.equal(turn({ resumedByUserId: PERSON, run: { ...firstRun, continuationOfRunId: 'parked' } }), true)
  assert.equal(turn({ resumedByUserId: PERSON, run: { ...firstRun, restartOfRunId: 'failed' } }), true)
  assert.equal(turn({
    batchMessageIds: [BATCHED, MESSAGE],
    messages: [composed(), composed({ id: BATCHED })],
  }), true)
})

// Facts as the loader returns them, for a bound CTO in #eng of a real project.
const facts = (overrides: Partial<ProjectOperatorFacts> = {}): ProjectOperatorFacts => ({
  agent: {
    agentKind: 'shared', parentAgentId: null, systemManaged: false, systemSlug: null,
    toolPolicy: { [PROJECT_OPERATOR_CAPABILITY_ID]: true },
  },
  bindings: 1,
  capabilityEnabled: true,
  channel: {
    archivedAt: null, deletedAt: null, dmKey: null, projectId: 'project', systemChannelType: null, type: 'standard',
    project: { channelRoot: false, deletedAt: null },
  },
  input: {
    actorId: PERSON, actorType: 'user', agentId: 'cto', channelId: 'eng', interactive: true, messageId: MESSAGE,
    organizationId: 'org', runId: 'run', threadId: THREAD,
  },
  messages: [composed()],
  run: firstRun,
  ...overrides,
}) as ProjectOperatorFacts

test('the arm opens on a live person\'s own turn in a bound project room, and names why it stays shut', () => {
  assert.equal(projectOperatorRefusal(facts()), null)
  const base = facts()
  const channel = base.channel!
  const refused: Array<[string, Partial<ProjectOperatorFacts>, string]> = [
    ['no grant', { agent: { ...base.agent!, toolPolicy: {} } }, 'no_grant'],
    ['a revoked grant', { agent: { ...base.agent!, toolPolicy: { [PROJECT_OPERATOR_CAPABILITY_ID]: false } } }, 'no_grant'],
    ['switched off for the organisation', { capabilityEnabled: false }, 'switched_off'],
    ['a worker continuation', { input: { ...base.input, interactive: false } }, 'not_a_live_turn'],
    ['an organisation-wide channel', {
      channel: { ...channel, project: { channelRoot: true, deletedAt: null } },
    }, 'not_a_project_room'],
    ['an archived channel', { channel: { ...channel, archivedAt: new Date() } }, 'not_a_project_room'],
    ['a deleted project', { channel: { ...channel, project: { channelRoot: false, deletedAt: new Date() } } }, 'not_a_project_room'],
    ['a direct-message type', { channel: { ...channel, type: 'dm' } }, 'not_a_project_room'],
    ['a system conversation', { channel: { ...channel, systemChannelType: 'system_agent' } }, 'not_a_project_room'],
    ['a direct message', { channel: { ...channel, dmKey: 'dm:a:b' } }, 'not_a_project_room'],
    ['not bound', { bindings: 0 }, 'not_bound'],
    [
      'somebody else\'s replayed message',
      { messages: [composed({ userId: OTHER })] as ProjectOperatorFacts['messages'] },
      'not_the_persons_own_turn',
    ],
  ]
  for (const [name, override, reason] of refused) {
    assert.equal(projectOperatorRefusal(facts(override)), reason, name)
  }
})

test('the operator verbs are the plan\'s set, and the capability is a grant, never a tool', () => {
  assert.deepEqual([...PROJECT_OPERATOR_TOOL_IDS].sort(), [
    'agent_trigger_create', 'agent_trigger_update', 'channel_create', 'kb_space_create',
    'project_create', 'project_list', 'project_structure_read', 'team_create', 'ticket_board_column_create',
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
  kind: 'personal_assistant' | 'shared' = 'shared',
) =>
  authorizeToolCall(toolId, allEnabled, BUILTIN_TOOL_DEFINITIONS, policy, null, kind, options).allowed

test('the gate admits an operator verb to a shared agent on the operator arm alone', () => {
  const operator = { liveRequester: true, projectOperatorToolIds: PROJECT_OPERATOR_TOOL_IDS }
  for (const toolId of ['project_create', 'channel_create', 'workflow_trigger_create', 'kb_space_create']) {
    assert.equal(allowed(toolId, operator), true, toolId)
    assert.equal(allowed(toolId, { liveRequester: true }), false, `${toolId} without the arm`)
  }
  // `ticket_board_create` is an explicit grant of its own; on the operator arm
  // the `project_operator` grant stands for it, on no other arm.
  assert.equal(allowed('ticket_board_create', operator), true)
  assert.equal(allowed('ticket_board_create', { liveRequester: true }), false)
  // The arm opens operator verbs only: other act-as-user tools stay shut.
  for (const toolId of ['agent_create', 'agent_bind_channel', 'send_message', 'agent_trigger_delete']) {
    assert.equal(allowed(toolId, operator), false, toolId)
  }
  // An explicit deny still wins.
  assert.equal(allowed('project_create', operator, { project_create: false }), false)
})

test('standing work and account discovery run only on a live person\'s turn, on every arm', () => {
  const live = ['workflow_create', 'workflow_update', 'workflow_install', 'workflow_trigger_create', 'workflow_run',
    'ticket_board_column_create', 'ticket_board_column_update', 'kb_space_create', 'account_connections_list']
  assert.deepEqual(
    BUILTIN_TOOL_DEFINITIONS.filter((tool) => tool.requiresLiveRequester).map((tool) => tool.id).sort(),
    [...live].sort(),
  )
  for (const toolId of live) {
    // The Personal Assistant's arm opens on the schedules it fires too: not for these.
    assert.equal(allowed(toolId, { liveRequester: true }, null, 'personal_assistant'), true, toolId)
    assert.deepEqual(
      authorizeToolCall(toolId, allEnabled, BUILTIN_TOOL_DEFINITIONS, null, null, 'personal_assistant', {}),
      { allowed: false, reason: 'live_requester_required' },
      toolId,
    )
  }
  // A PA-only verb the capability did not add keeps its arm as it was.
  assert.equal(allowed('project_create', {}, null, 'personal_assistant'), true)
})

test('a refused verb off the person\'s own turn says to ask them to repeat it', () => {
  const granted = { [PROJECT_OPERATOR_CAPABILITY_ID]: true }
  assert.equal(
    liveTurnDenialMessage('project_create', 'personal_assistant_only', { liveRequester: false, toolPolicy: granted }),
    PROJECT_OPERATOR_LIVE_TURN_REFUSAL,
  )
  assert.equal(
    liveTurnDenialMessage('workflow_run', 'live_requester_required', { liveRequester: false, toolPolicy: null }),
    PROJECT_OPERATOR_LIVE_TURN_REFUSAL,
  )
  assert.match(PROJECT_OPERATOR_LIVE_TURN_REFUSAL, /ask them to repeat the request/)
  // On a live turn, or for an agent without the grant, the gate keeps its own sentence.
  assert.equal(liveTurnDenialMessage('project_create', 'personal_assistant_only', {
    liveRequester: true, toolPolicy: granted,
  }), null)
  assert.equal(liveTurnDenialMessage('project_create', 'personal_assistant_only', {
    liveRequester: false, toolPolicy: {},
  }), null)
})

test('a shared agent without the arm is offered no workflow write, and keeps the reads', () => {
  const offered = resolveAgentTools(allEnabled, BUILTIN_TOOL_DEFINITIONS, null, null, 'shared', {
    liveRequester: true,
  }).allowedIds
  for (const toolId of ['workflow_create', 'workflow_update', 'workflow_install', 'workflow_trigger_create', 'workflow_run']) {
    assert.equal(offered.has(toolId), false, toolId)
  }
  for (const toolId of ['workflow_list', 'workflow_preview', 'workflow_run_status']) {
    assert.equal(offered.has(toolId), true, toolId)
  }
  const operatorRun = resolveAgentTools(allEnabled, BUILTIN_TOOL_DEFINITIONS, null, null, 'shared', {
    liveRequester: true,
    projectOperatorToolIds: PROJECT_OPERATOR_TOOL_IDS,
  })
  for (const toolId of PROJECT_OPERATOR_TOOL_IDS) assert.equal(operatorRun.allowedIds.has(toolId), true, toolId)
})

test('the Personal Assistant keeps the workflow verbs on its own arm, on its owner\'s live turn', () => {
  const offered = resolveAgentTools(allEnabled, BUILTIN_TOOL_DEFINITIONS, null, null, 'personal_assistant', {
    liveRequester: true,
  }).allowedIds
  for (const toolId of ['workflow_create', 'workflow_install', 'workflow_trigger_create', 'workflow_run']) {
    assert.equal(offered.has(toolId), true, toolId)
  }
  const scheduled = resolveAgentTools(allEnabled, BUILTIN_TOOL_DEFINITIONS, null, null, 'personal_assistant').allowedIds
  for (const toolId of ['workflow_create', 'workflow_install', 'workflow_trigger_create', 'workflow_run']) {
    assert.equal(scheduled.has(toolId), false, `${toolId} on a schedule`)
  }
})
