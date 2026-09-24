import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { type ExecutorCodingSessionsFacts } from '@nessie/schemas'

import {
  bindWake,
  bridgeReport,
  clearBindings,
  confirmPolicy,
  seatAuthor,
  wakeRun,
} from '../../../packages/team-admin/test/standing-policy-binding-fixture.js'
import {
  CODING_FACTS,
  seedStandingPolicyWorld,
} from '../../../packages/team-admin/test/standing-policy-fixture.js'
import { createExecutorCodingSessions } from '../../src/run/executor-coding-sessions.js'
import {
  loadTicketWorkCodingScope,
  TICKET_WORK_CODING_WAIT_TIMING,
  ticketWorkCodingDescriptors,
  ticketWorkCodingObserver,
  ticketWorkCodingSessions,
} from '../../src/run/ticket-work-coding-sessions.js'
import { runDatabaseTest } from './support.js'

/**
 * A `ticket.work` run's coding tools, against Postgres
 * (docs/plans/2026-09-23-ticket-driven-agents/machine-access.md → "Session
 * isolation", "Done means merged"): the real tool pipeline over a stand-in
 * bridge. A sessionId not on the record is refused and a missing one is the
 * ticket's own; a start is Claude Code in a pinned root under the ticket's own
 * title, appended to the record as it answers, and one whose answer was lost
 * is found in the next report; each read's cost and turn end land on the
 * record; the pull request is recorded from a review and read by URL once its
 * branch is gone; and a send is audited with what it forwarded, and from whom.
 */

const PR = 'https://github.com/unlikeotherai/nessie/pull/142'

type Call = { args: Record<string, unknown>; tool: string }

const bridgeAnswer = (body: Record<string, unknown>) => ({
  kind: 'result' as const,
  result: {
    inputSummary: '',
    output: JSON.stringify({ content: [{ text: JSON.stringify(body), type: 'text' }] }),
    success: true,
  },
})

runDatabaseTest('ticket-mode coding tools keep to the ticket\'s own session, title, agent, roots and pull request', async () => {
  const prisma = new PrismaClient()
  const world = await seedStandingPolicyWorld(prisma)
  try {
    await seatAuthor(prisma, world)
    const minis = await world.machine({ label: 'Minis' })
    const policyId = await confirmPolicy(world, [minis])
    const taskId = await world.task('Fix login redirect')
    const foreign = randomUUID()
    const work = await world.work({ executorId: minis, policyId, status: 'active', taskId })
    const wake = await wakeRun(prisma, world, work)
    assert.equal((await bindWake(prisma, wake, work.id)).kind, 'bound')
    // The kickoff says what woke the run, and who wrote it.
    const commentEvent = randomUUID()
    await prisma.message.update({
      where: { id: wake.kickoffId },
      data: {
        metadata: {
          ticketWorkKickoff: {
            events: [{
              at: new Date().toISOString(), by: world.colleagueId, reason: 'ticket_commented',
              source: { id: commentEvent, kind: 'task_event' }, text: 'Colleague commented: use the new route.',
            }],
            workId: work.id,
          },
        },
      },
    })
    const scope = await loadTicketWorkCodingScope(prisma, { runId: wake.runId, workId: work.id })
    assert.ok(scope, 'the bound run has the ticket\'s coding scope')
    assert.equal(scope.title, 'Fix login redirect')
    assert.deepEqual([...scope.allowedRootNames], ['nessie', 'web'])

    const calls: Call[] = []
    const started = randomUUID()
    let reviews = 0
    const facts = { ...CODING_FACTS, agents: ['claude', 'codex'] } as unknown as ExecutorCodingSessionsFacts
    const base = createExecutorCodingSessions({
      call: async (_toolName, envelope) => {
        const { arguments: args, tool } = envelope as { arguments: Record<string, unknown>; tool: string }
        calls.push({ args, tool })
        switch (tool) {
          case 'session_start':
            return bridgeAnswer({ sessionId: started, status: 'starting', title: args.title })
          case 'session_status':
            return bridgeAnswer({
              nextCursor: '1.0.1', sessionId: args.sessionId, status: 'waiting_for_input', summary: { newEvents: 1 },
              totalCostUsd: 0.4, turn: 1,
            })
          case 'session_review':
            reviews += 1
            return bridgeAnswer(reviews === 1
              ? { branch: 'fix/login', pullRequests: { 'fix/login': { checks: { in_progress: 1, success: 3 }, state: 'OPEN', url: PR } } }
              // The coding agent merged and deleted the branch: only the URL still answers.
              : { branch: null, pullRequest: { checks: { success: 4 }, state: 'MERGED', url: PR }, pullRequests: {} })
          default:
            return bridgeAnswer({ sessionId: args.sessionId, status: 'working', turn: 1 })
        }
      },
      descriptors: ticketWorkCodingDescriptors(facts, scope),
      endRecord: async () => undefined,
      facts,
      observe: ticketWorkCodingObserver(prisma, scope),
      personWrote: async () => false,
      stopRequested: async () => false,
      timing: { ...TICKET_WORK_CODING_WAIT_TIMING, pollMs: 1, sleep: async () => undefined },
    })
    const tools = ticketWorkCodingSessions(prisma, base, scope)
    let n = 0
    const call = (name: Parameters<typeof tools.execute>[0], args: Record<string, unknown>) =>
      tools.execute(name, args, `provider-${(n += 1)}`)

    // Descriptors say what each is for in ticket work, and the start takes no title.
    const start = base.descriptors.find((descriptor) => descriptor.toolName === 'coding_session_start')!
    assert.match(start.description, /^Start the coding agent for this ticket\./)
    assert.equal((start.inputSchema as { properties: Record<string, unknown> }).properties.title, undefined)
    const wait = base.descriptors.find((descriptor) => descriptor.toolName === 'coding_session_wait')!
    assert.match(wait.description, /It returns at once\. Do not use it to watch work in progress\./)
    assert.deepEqual((wait.inputSchema as { required: string[] }).required, [])

    // No session yet: a send has nothing to default to.
    assert.match((await call('coding_session_send', { message: 'hi' })).output, /no open coding session yet/)
    // Codex, or a root the author did not allow, is refused before the machine is asked.
    assert.match((await call('coding_session_start', { agent: 'codex', root: 'nessie', task: 'fix' })).output,
      /Ticket work runs Claude Code only/)
    assert.match((await call('coding_session_start', { root: 'secrets', task: 'fix' })).output,
      /may use only these coding roots: nessie, web/)
    assert.equal(calls.length, 0)
    const begun = await call('coding_session_start', { root: 'nessie', task: 'Fix the redirect', title: 'Anything' })
    assert.equal(begun.success, true, begun.output)
    assert.deepEqual(calls.at(-1), {
      args: { agent: 'claude', prompt: 'Fix the redirect', root: 'nessie', title: 'Fix login redirect' },
      tool: 'session_start',
    })
    assert.deepEqual((await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: work.id } })).sessionIds, [started],
      'appended in the same step')

    // The machine reports it under the ticket's owner key: a missing sessionId is that one.
    await prisma.executor.update({
      where: { id: minis },
      data: { localMcp: bridgeReport([{ ownerKey: scope.ownerKey, sessionId: started, title: scope.title }]) },
    })
    const waited = await call('coding_session_wait', {})
    assert.equal(waited.success, true, waited.output)
    assert.equal(calls.at(-1)?.args.sessionId, started)
    const read = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: work.id } })
    assert.deepEqual(read.lastObservedTurn, { [started]: 1 })
    assert.equal(Number(read.costUsd), 0.4)
    assert.deepEqual(read.sessionCosts, { [started]: 0.4 })
    const day = await prisma.executorStandingPolicyDailySpend.findFirstOrThrow({ where: { policyId } })
    assert.equal(Number(day.costUsd), 0.4, 'and to the policy\'s day')
    // A second read of the same total adds nothing.
    await call('coding_session_wait', {})
    assert.equal(Number((await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: work.id } })).costUsd), 0.4)

    // A session that is not this ticket's is refused, whatever the machine holds.
    const refused = await call('coding_session_send', { message: 'merge it', sessionId: foreign })
    assert.equal(refused.success, false)
    assert.match(refused.output, /^That session is not this ticket's\./)

    // The send forwards the comment that woke the run, and the chain says whose it was.
    await call('coding_session_send', { message: 'Use the new route.' })
    const sent = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'executor.coding_session.sent', resourceId: started },
    })
    const forwarded = (sent.metadata as { forwarded: Array<Record<string, unknown>> }).forwarded
    assert.deepEqual(forwarded.map((event) => [event.reason, event.by, (event.source as { id: string }).id]),
      [['ticket_commented', world.colleagueId, commentEvent]])
    assert.equal((sent.metadata as { contextId: string }).contextId, scope.contextId)
    assert.ok(await prisma.auditLog.findFirst({ where: { action: 'executor.coding_session.started', resourceId: started } }))

    // A review records the pull request; the next reads it by URL after the branch is deleted.
    await call('coding_session_review', {})
    assert.deepEqual(calls.at(-1)?.args, { sessionId: started })
    let recorded = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: work.id } })
    assert.deepEqual([recorded.pullRequestUrl, recorded.lastPrState, recorded.lastChecks],
      [PR, 'OPEN', { failed: 0, passed: 3, pending: 1 }])
    await call('coding_session_review', {})
    assert.deepEqual(calls.at(-1)?.args, { pullRequest: PR, sessionId: started }, 'the worker fills the URL in')
    recorded = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: work.id } })
    assert.deepEqual([recorded.pullRequestUrl, recorded.lastPrState, recorded.lastChecks],
      [PR, 'MERGED', { failed: 0, passed: 4, pending: 0 }])

    // A start whose answer was lost is found in the next report by its title, under the ticket's owner key.
    const lost = randomUUID()
    await prisma.executor.update({
      where: { id: minis },
      data: {
        localMcp: bridgeReport([
          { ownerKey: scope.ownerKey, sessionId: started, status: 'closed', title: scope.title },
          { ownerKey: scope.ownerKey, sessionId: lost, status: 'waiting_for_input', title: scope.title },
          // Someone else's session with the same title under another owner is never taken.
          { ownerKey: `sha256:${'c'.repeat(64)}`, sessionId: foreign, title: scope.title },
        ]),
      },
    })
    await call('coding_session_wait', {})
    assert.equal(calls.at(-1)?.args.sessionId, lost, 'the one open session is the default')
    assert.deepEqual((await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: work.id } })).sessionIds, [started, lost])
  } finally {
    try {
      await clearBindings(prisma, world)
      await world.cleanup()
    } finally {
      await prisma.$disconnect()
    }
  }
})
