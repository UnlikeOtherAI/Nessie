import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { ExecutorCodingSessionsFacts } from '@nessie/schemas'

import { CODING_SESSION_TOOL_NAMES } from './coding-session-tools.js'
import type { ExecutorCommandOutcome } from './executor-command-dispatch.js'
import { ExecutorUnknownOutcomeError } from './executor-command-timing.js'
import {
  codingSessionsOffer,
  codingWaitRunChecks,
  createExecutorCodingSessions,
} from './executor-coding-sessions.js'

const OWNER = '00000000-0000-4000-8000-0000000000a1'
const OTHER = '00000000-0000-4000-8000-0000000000a2'
const SESSION = '00000000-0000-4000-8000-0000000000c1'

const facts: ExecutorCodingSessionsFacts = {
  agents: ['claude', 'codex'], allowedToolCount: 3, configDigest: `sha256:${'c'.repeat(64)}`, environmentNames: [],
  permissionMode: { claude: 'acceptEdits', codex: 'default' }, rootNames: ['nessie', 'site'], serverName: 'coding-sessions',
}

const candidates = (actorUserId: string) => ({
  executorAvailabilityCandidate: { findUnique: async () => ({ actorUserId }) },
}) as unknown as PrismaClient

const binding = (overrides: Record<string, unknown> = {}) => ({
  candidateHandleDigest: 'digest',
  capabilityRevision: { descriptor: { codingSessions: facts, mcpServers: ['coding-sessions', 'kelpie'] } },
  executor: { pairingOwnerUserId: OWNER, scopeKind: 'private' as const },
  id: 'binding-call',
  operationKey: 'mcp.call',
  ...overrides,
})

test('the tools are offered on a private executor, to its pairing owner, for a revision with the bridge', async () => {
  assert.deepEqual(await codingSessionsOffer(candidates(OWNER), [binding()], true), { bindingId: 'binding-call', facts })
  // Someone else on the owner's private machine.
  assert.equal(await codingSessionsOffer(candidates(OTHER), [binding()], true), null)
  // The owner on a shared machine.
  assert.equal(await codingSessionsOffer(candidates(OWNER), [binding({
    executor: { pairingOwnerUserId: OWNER, scopeKind: 'project' },
  })], true), null)
  // A revision without the bridge's facts, whatever its programs are called.
  assert.equal(await codingSessionsOffer(candidates(OWNER), [binding({
    capabilityRevision: { descriptor: { mcpServers: ['coding-sessions'] } },
  })], true), null)
  // The agent's policy does not allow the call the tools are made of.
  assert.equal(await codingSessionsOffer(candidates(OWNER), [binding()], false), null)
  // Nothing but the catalog half is bound.
  assert.equal(await codingSessionsOffer(candidates(OWNER), [binding({ operationKey: 'mcp.tools' })], true), null)
})

type Sent = { args: Record<string, unknown>; expiresBy?: Date; providerToolCallId: string; toolName: string }

const answer = (body: Record<string, unknown>, toolCallRecordId: string): ExecutorCommandOutcome => ({
  kind: 'result',
  result: {
    inputSummary: '',
    output: JSON.stringify({ content: [{ text: JSON.stringify(body), type: 'text' }], success: true }),
    success: true,
    toolCallRecordId,
  },
})

const harness = (reply: (sent: Sent, index: number) => ExecutorCommandOutcome, checks: {
  personWrote?: () => Promise<boolean>
} = {}) => {
  const sent: Sent[] = []
  const ended: Array<{ id: string; success: boolean }> = []
  let now = 0
  const sessions = createExecutorCodingSessions({
    call: async (toolName, args, providerToolCallId, expiresBy) => {
      const call = { args, providerToolCallId, toolName, ...(expiresBy ? { expiresBy } : {}) }
      sent.push(call)
      return reply(call, sent.length - 1)
    },
    endRecord: async (id, result) => { ended.push({ id, success: result.success }) },
    facts,
    personWrote: checks.personWrote ?? (async () => false),
    stopRequested: async () => false,
    timing: { now: () => now, pollMs: 5_000, sleep: async (ms) => { now += ms } },
  })
  return { ended, sent, sessions }
}

test('a start is the bridge’s session_start: task becomes prompt, and the agent defaults to Claude Code', async () => {
  const { sent, sessions } = harness(() => answer({ sessionId: SESSION, status: 'starting' }, 'row-1'))
  const result = await sessions.execute(CODING_SESSION_TOOL_NAMES.start, {
    extra: 'dropped', root: 'nessie', task: 'Fix the pricing page. Open a PR.',
  }, 'call-1')
  assert.deepEqual(sent[0], {
    args: {
      arguments: { agent: 'claude', prompt: 'Fix the pricing page. Open a PR.', root: 'nessie' },
      server: 'coding-sessions',
      tool: 'session_start',
    },
    providerToolCallId: 'call-1',
    toolName: 'coding_session_start',
  })
  assert.equal(result.success, true)
  assert.equal(result.toolCallRecordId, 'row-1')
  assert.match(result.output, new RegExp(`^Started coding session ${SESSION}\\. Call coding_session_wait next\\.`))
  assert.match(result.output, /Output of the program `coding-sessions` on the person's machine/)
})

test('a wait reads every five seconds under the call’s own id first, and ends every later read’s row itself', async () => {
  let reads = 0
  const progress: string[] = []
  const { ended, sent, sessions } = harness((call) => {
    reads += 1
    const body = reads < 3
      ? { agent: 'claude', sessionId: SESSION, status: 'working', summary: { newEvents: 1, toolCounts: { Bash: 1 } }, turn: 1 }
      : { agent: 'claude', lastResult: { permissionDenials: [], text: 'Done.' }, sessionId: SESSION, status: 'waiting_for_input', turn: 1 }
    return answer(body, `row-${call.providerToolCallId}`)
  })
  const result = await sessions.execute(CODING_SESSION_TOOL_NAMES.wait, { sessionId: SESSION }, 'call-2', {
    onProgress: async (toolName, line) => { progress.push(`${toolName}|${line}`) },
  })
  assert.deepEqual(sent.map((call) => call.providerToolCallId), ['call-2', 'call-2:poll-1', 'call-2:poll-2'])
  assert.ok(sent.every((call) => call.args.tool === 'session_status' && call.expiresBy instanceof Date))
  assert.deepEqual(sent[0]!.args.arguments, { sessionId: SESSION })
  assert.equal(result.toolCallRecordId, 'row-call-2', 'the call’s own row carries the digest')
  assert.deepEqual(ended.map((row) => row.id), ['row-call-2:poll-1', 'row-call-2:poll-2'])
  assert.deepEqual(result.watch, { progressed: true, state: 'needs_model' }, 'the turn ended: the model acts next')
  assert.match(result.output, /^The turn ended and the session is waiting for input/)
  // One line, rewritten: the latest digest, never the coding agent's own words.
  assert.equal(progress.at(-1), 'coding_session_wait|Claude Code: waiting for input — turn 1, 2 steps (Bash 2)')
  assert.ok(progress.every((line) => !line.includes('Done.')))
})

test('a wait after a send is not answered by the turn before it', async () => {
  let reads = 0
  const { sessions } = harness((call) => {
    if (call.toolName === 'coding_session_send') return answer({ queued: true, sessionId: SESSION, status: 'waiting_for_input' }, 'row-send')
    reads += 1
    // Turn 1 ends; the first read after the send still shows it (the host has
    // taken the message but not yet written the turn it starts); then turn 2
    // works and ends.
    const status = reads === 3 ? 'working' : 'waiting_for_input'
    const turn = reads <= 2 ? 1 : 2
    return answer({ agent: 'claude', sessionId: SESSION, status, turn, summary: { newEvents: 1, toolCounts: {} } }, `row-${reads}`)
  })
  await sessions.execute(CODING_SESSION_TOOL_NAMES.wait, { sessionId: SESSION }, 'call-a')
  await sessions.execute(CODING_SESSION_TOOL_NAMES.send, { message: 'Also add a test.', sessionId: SESSION }, 'call-b')
  const second = await sessions.execute(CODING_SESSION_TOOL_NAMES.wait, { sessionId: SESSION }, 'call-c')
  assert.match(second.output, /"turn":2/)
  assert.equal(reads, 4, 'the second wait read past the old turn until turn 2 had ended')
})

test('a read whose own TTL ran out is an unknown outcome, and the call’s own row is ended on the way out', async () => {
  const { ended, sessions } = harness((call, index) => (index === 0
    ? answer({ sessionId: SESSION, status: 'working', summary: { newEvents: 0 }, turn: 1 }, `row-${call.providerToolCallId}`)
    : { capped: false, kind: 'expired', toolCallRecordId: 'row-expired' }))
  await assert.rejects(
    sessions.execute(CODING_SESSION_TOOL_NAMES.wait, { sessionId: SESSION }, 'call-3'),
    (error: unknown) => error instanceof ExecutorUnknownOutcomeError && error.toolCallRecordId === 'row-expired',
  )
  assert.deepEqual(ended, [{ id: 'row-call-3', success: false }])
})

test('a wait that saw nothing move says so, for the loop detector', async () => {
  const quiet = { sessionId: SESSION, status: 'working', summary: { newEvents: 0, toolCounts: {} }, turn: 1 }
  const { sessions } = harness((call) => answer(quiet, `row-${call.providerToolCallId}`), {})
  const first = await sessions.execute(CODING_SESSION_TOOL_NAMES.wait, { sessionId: SESSION }, 'call-4')
  assert.deepEqual(first.watch, { progressed: true, state: 'watching' }, 'the first look at a session is news')
  const second = await sessions.execute(CODING_SESSION_TOOL_NAMES.wait, { sessionId: SESSION }, 'call-5')
  assert.deepEqual(second.watch, { progressed: false, state: 'watching' })
  assert.match(second.output, /is still working; calling coding_session_wait again is expected/)
})

test('the bridge’s own refusals are stated as ours, and the ones a model fixes are correctable', async () => {
  const refusal = (code: string, message: string): ExecutorCommandOutcome => ({
    kind: 'result',
    result: {
      inputSummary: '',
      output: JSON.stringify({
        code: 'EXECUTOR_MCP_CALL_FAILED', content: [{ text: JSON.stringify({ code, message }), type: 'text' }],
        isError: true, success: false,
      }),
      success: false,
    },
  })
  const { sessions } = harness(() => refusal('coding_session_quota_exceeded', 'You already have 3 open coding sessions.'))
  const quota = await sessions.execute(CODING_SESSION_TOOL_NAMES.start, { root: 'nessie', task: 'x' }, 'call-6')
  assert.equal(quota.success, false)
  assert.equal(quota.correctable, true)
  assert.equal(quota.output, 'The call did not complete (coding_session_quota_exceeded). You already have 3 open coding sessions.')
  const { sessions: changed } = harness(() => refusal('coding_session_config_changed', 'Review it again.'))
  assert.equal((await changed.execute(CODING_SESSION_TOOL_NAMES.list, {}, 'call-7')).correctable, undefined)
})

test('a review is framed as the coding agent’s work', async () => {
  const { sessions } = harness(() => answer({ branch: 'fix/pricing', commits: ['Fix pricing'], sessionId: SESSION }, 'row-8'))
  const review = await sessions.execute(CODING_SESSION_TOOL_NAMES.review, { sessionId: SESSION }, 'call-8')
  assert.ok(review.output.startsWith(
    'What the session actually changed, as git on the machine reports it. Report only this.',
  ))
  assert.match(review.output, /Output from the coding agent you supervise\./)
})

test('a wait the person’s message ended tells the loop the turn is over', async () => {
  const working = { agent: 'claude', sessionId: SESSION, status: 'working', summary: { newEvents: 1, toolCounts: {} }, turn: 1 }
  const { sessions } = harness((call) => answer(working, `row-${call.providerToolCallId}`), {
    personWrote: async () => true,
  })
  const result = await sessions.execute(CODING_SESSION_TOOL_NAMES.wait, { sessionId: SESSION }, 'call-9')
  assert.deepEqual(result.watch, { progressed: true, state: 'end_turn' })
  assert.match(result.output, /^The person sent a message; end your turn now/)
})

test('the person-wrote check reads a live chat message pending for this agent in this thread, and nothing else', async () => {
  const queries: unknown[] = []
  const createdAt = new Date('2026-09-23T20:00:00.000Z')
  const checks = codingWaitRunChecks({
    run: { findUnique: async () => ({ cancelRequestedAt: null, createdAt, principalUserId: null, threadId: 'thread-1' }) },
    runThreadPendingMessage: {
      findFirst: async (query: unknown) => {
        queries.push(query)
        return null
      },
    },
  } as unknown as Pick<PrismaClient, 'run' | 'runThreadPendingMessage'>, { agentId: 'agent-1', runId: 'run-1' })
  assert.equal(await checks.personWrote(), false)
  assert.deepEqual((queries[0] as { where: unknown }).where, {
    agentId: 'agent-1',
    // A message still pending from before this run began is not one the person wrote while it waited.
    createdAt: { gt: createdAt },
    interactive: true, principalUserId: null, threadId: 'thread-1', triggerId: null,
  })
  assert.equal(await checks.stopRequested(), false)
})
