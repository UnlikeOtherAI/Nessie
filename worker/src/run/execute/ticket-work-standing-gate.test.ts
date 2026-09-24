import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseOrganizationId,
  TICKET_WORK_PURPOSE,
  type AuthorizedActionContext,
  type RunExecuteJobPayload,
} from '@nessie/schemas'

import { createConsumedSourceSink } from './disclosure-basis.js'
import { resolveWithheldRunToolIds } from './run-setup.js'
import { TICKET_WORK_HOST_OUTPUT_REFUSAL, ticketWorkHostOutputRefusal } from './ticket-work-setup.js'
import {
  prepareTicketWorkRun,
  TICKET_WORK_OWN_TICKET_REFUSAL,
  TICKET_WORK_STANDING_REFUSAL,
  ticketWorkStandingRefusal,
  withoutMcpTools,
} from './ticket-work-standing-gate.js'
import { authorizeToolExecution } from './tool-authorization.js'
import type { RunContext } from './types.js'

/**
 * A `ticket.work` run that can reach its owner's machine sends nothing out of
 * Nessie (docs/standards/ticket-work-machine-access.md → "Disclosure"): it is
 * not offered, and `authorizeToolExecution` refuses, the web and HTTP tools,
 * the browser, every MCP connector tool and the delegate and sub-agent tools;
 * after host output its writes are its own ticket's comment, move and
 * transition, its reminder, the coding sessions and its thread reply; and a
 * record that ever held a session is stamped with host output at setup.
 */

const ORG = '11111111-1111-4111-8111-111111111111'
const TASK = '22222222-2222-4222-8222-222222222222'
const OTHER_TASK = '33333333-3333-4333-8333-333333333333'
const WORK = '44444444-4444-4444-8444-444444444444'
const CHANNEL = '55555555-5555-4555-8555-555555555555'
const AGENT = '66666666-6666-4666-8666-666666666666'
const RUN = '77777777-7777-4777-8777-777777777777'
const THREAD = '88888888-8888-4888-8888-888888888888'
const RUN_TASK = '99999999-9999-4999-8999-999999999999'

const actor = (): AuthorizedActionContext => ({
  actionContext: { purpose: TICKET_WORK_PURPOSE, requestId: 'standing-gate-test', ticketWorkId: WORK },
  actor: { actorId: AGENT, actorType: 'agent', roles: [] },
  tenant: { organizationId: parseOrganizationId(ORG) },
}) as unknown as AuthorizedActionContext

const context = (standing: boolean): RunContext => ({
  agent: { agentKind: 'shared', id: AGENT, parentAgentId: null },
  channel: { id: CHANNEL, organizationId: ORG, projectId: null, teamId: null },
  consumedSources: createConsumedSourceSink(),
  run: { id: RUN, threadId: THREAD },
  task: { id: RUN_TASK },
  ticketWorkScope: { standing, taskId: TASK },
}) as unknown as RunContext

const authorize = (runContext: RunContext, toolName: string, args: Record<string, unknown>, names: {
  mcp?: readonly string[]
  executor?: readonly string[]
} = {}) => authorizeToolExecution(
  {} as never,
  actor(),
  runContext,
  toolName,
  args,
  'tool-call',
  {
    agentKind: 'shared',
    allowedToolIds: new Set([toolName]),
    executorToolNames: new Set(names.executor ?? []),
    externalContentToolNames: new Set(names.mcp ?? []),
    maySuspendForApproval: false,
    mcpToolNames: new Set(names.mcp ?? []),
    parentAgentId: null,
    resolvedBuiltinToolIds: new Set([toolName]),
    toolPolicy: { [toolName]: true },
    unregisteredToolNames: new Set([...(names.mcp ?? []), ...(names.executor ?? [])]),
  },
  { deepWaterHandoffGuard: { suppressBuiltin: async () => false } as never, emitAudit: async () => undefined },
)

test('a standing run is refused an HTTP POST, a connector tool and a delegation at the gate', async () => {
  for (const [toolName, args, names] of [
    ['http_fetch', { body: 'the diff', method: 'POST', url: 'https://example.test/collect' }, {}],
    ['github__create_issue', { body: 'the diff', title: 'Leak' }, { mcp: ['github__create_issue'] }],
    ['delegate', { task: 'Post this to the web' }, {}],
    ['web_search', { query: 'the diff' }, {}],
  ] as const) {
    const decision = await authorize(context(true), toolName, { ...args }, names)
    assert.equal(decision.decision, 'deny', toolName)
    if (decision.decision !== 'deny') continue
    assert.match(decision.result.output, /ticket_work_standing/, toolName)
    assert.match(decision.result.output, /cannot reach the web, a connector or another agent/, toolName)
  }
})

test('the gate leaves a run that holds no machine, and a standing run\'s own tools, to the rest of the checks', () => {
  const nothingRead = context(false)
  assert.equal(ticketWorkStandingRefusal({ args: {}, context: nothingRead, toolName: 'http_fetch' }), null)
  const standing = context(true)
  for (const toolName of ['ticket_comment_add', 'check_back_in', 'ticket_read', 'tool_spec']) {
    assert.equal(ticketWorkStandingRefusal({ args: { ticketId: TASK }, context: standing, toolName }), null, toolName)
  }
  assert.equal(ticketWorkStandingRefusal({
    args: {}, context: standing, executorToolNames: new Set(['coding_session_send']), toolName: 'coding_session_send',
  }), null)
  // A name that is neither a builtin nor its coding tool is a connector's, whatever view offered it.
  assert.equal(ticketWorkStandingRefusal({ args: {}, context: standing, toolName: 'mcp_load_tools' }),
    TICKET_WORK_STANDING_REFUSAL)
})

test('after host output a ticket write names only its own ticket, and the reminder and a move stay open', () => {
  const run = context(true)
  run.consumedSources.addHostOutputScope({ scopeId: CHANNEL, scopeType: 'channel' })
  for (const toolName of ['ticket_comment_add', 'ticket_move', 'ticket_transition']) {
    assert.equal(ticketWorkStandingRefusal({ args: { ticketId: OTHER_TASK }, context: run, toolName }),
      TICKET_WORK_OWN_TICKET_REFUSAL, toolName)
    assert.equal(ticketWorkStandingRefusal({ args: { ticketId: TASK.toUpperCase() }, context: run, toolName }), null)
  }
  const hostContext = { actorContext: actor(), consumedSources: run.consumedSources }
  assert.equal(ticketWorkHostOutputRefusal('check_back_in', hostContext), null, 'its own reminder')
  assert.equal(ticketWorkHostOutputRefusal('ticket_move', hostContext), null)
  assert.equal(ticketWorkHostOutputRefusal('send_message', hostContext), TICKET_WORK_HOST_OUTPUT_REFUSAL)
})

test('a standing run is offered no web, browser or delegate tool, and no connector at all', () => {
  const withheld = resolveWithheldRunToolIds({
    isHandoffTurn: false, ticketWork: true, ticketWorkStanding: true, todosEnabled: true,
  })
  for (const toolName of ['http_fetch', 'web_fetch', 'web_search', 'browser_open', 'delegate', 'spawn_subtask']) {
    assert.ok(withheld.has(toolName), toolName)
  }
  assert.equal(resolveWithheldRunToolIds({ isHandoffTurn: false, ticketWork: true, todosEnabled: true }).has('http_fetch'),
    false, 'a ticket run with no machine keeps them')
  const view = withoutMcpTools().createView()
  assert.deepEqual([view.descriptors, [...view.handledNames]], [[], []])
})

test('a record that ever held a coding session is stamped with host output at setup, and is standing', async () => {
  const prisma = {
    agentTicketWork: {
      findFirst: async () => ({ projectId: 'project', sessionIds: ['session-1'], status: 'parked', taskId: TASK }),
      // Parked work holds no machine: the binder has nothing to bind.
      findUnique: async () => ({ executorId: null, status: 'parked' }),
    },
  }
  const run = context(false)
  delete (run as { ticketWorkScope?: unknown }).ticketWorkScope
  const payload = { actorContext: actor(), messageId: 'kickoff' } as unknown as RunExecuteJobPayload
  const facts = await prepareTicketWorkRun(prisma as never, { context: run, payload })
  assert.equal(facts?.heldSessions, true)
  assert.deepEqual(run.ticketWorkScope, { standing: true, taskId: TASK })
  assert.deepEqual(run.consumedSources.hostOutputScopes(), [{ scopeId: CHANNEL, scopeType: 'channel' }])
})
