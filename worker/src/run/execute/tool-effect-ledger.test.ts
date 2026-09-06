import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { Prisma, type PrismaClient } from '@prisma/client'

import { buildDeferredView } from '../mcp-toolset-deferred.js'
import type { McpToolEntry } from '../mcp-toolset.js'
import { runSpawnSubtaskTool } from '../subtask-tools.js'
import type { ExecutedToolResult } from '../tool-batch.js'
import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import {
  createToolEffectLedger,
  externalDispatchPredicate,
  TOOL_EFFECT_STATES,
} from './tool-effect-ledger.js'

// What the ledger does when the world does not cooperate: a dispatch that
// throws instead of returning, a call that has to be run a second time, and a
// provider that gives an id it should not have.
//
// The claim table is the only thing these touch, so the store below is the
// whole database. It implements the four operations `tool-effect-ledger.ts`
// uses with the semantics Postgres gives them — in particular `createMany` with
// `skipDuplicates` is `ON CONFLICT DO NOTHING` against the
// `(run_id, tool_call_id)` unique index, so its count answers "did THIS
// execution claim the call", and `updateMany` only touches rows its `where`
// matched, which is what scopes a settle to the claim this execution holds.

type StoredRow = {
  result: unknown
  runId: string
  settledAt: Date | null
  state: string
  toolCallId: string
  toolName: string
}

const createEffectStore = () => {
  const rows = new Map<string, StoredRow>()
  const key = (runId: string, toolCallId: string) => `${runId}::${toolCallId}`

  const matches = (row: StoredRow, where: Record<string, unknown>): boolean =>
    (where['runId'] === undefined || row.runId === where['runId'])
    && (where['toolCallId'] === undefined || row.toolCallId === where['toolCallId'])
    && (where['state'] === undefined || row.state === where['state'])

  const runToolEffect = {
    createMany: async (
      { data }: { data: Array<Omit<StoredRow, 'result' | 'settledAt'>>; skipDuplicates?: boolean },
    ) => {
      let count = 0
      for (const entry of data) {
        const at = key(entry.runId, entry.toolCallId)
        if (rows.has(at)) continue
        rows.set(at, { ...entry, result: null, settledAt: null })
        count += 1
      }
      return { count }
    },
    deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
      let count = 0
      for (const [at, row] of [...rows.entries()]) {
        if (!matches(row, where)) continue
        rows.delete(at)
        count += 1
      }
      return { count }
    },
    findUnique: async ({ where }: { where: { runId_toolCallId: { runId: string; toolCallId: string } } }) =>
      rows.get(key(where.runId_toolCallId.runId, where.runId_toolCallId.toolCallId)) ?? null,
    updateMany: async (
      { data, where }: { data: Record<string, unknown>; where: Record<string, unknown> },
    ) => {
      let count = 0
      for (const row of rows.values()) {
        if (!matches(row, where)) continue
        for (const [field, value] of Object.entries(data)) {
          // `Prisma.DbNull` is the SQL-NULL sentinel for a nullable Json column.
          const stored = value === Prisma.DbNull ? null : value
          ;(row as unknown as Record<string, unknown>)[field] = stored
        }
        count += 1
      }
      return { count }
    },
  }

  return {
    prisma: { runToolEffect } as unknown as PrismaClient,
    row: (runId: string, toolCallId: string) => rows.get(key(runId, toolCallId)) ?? null,
    // Exposed on its own so a test whose tool needs a wider database can put
    // the claim table beside the tables that tool writes — one Prisma
    // stand-in, because the real handler runs against one client.
    runToolEffect,
    size: () => rows.size,
  }
}

const RUN_ID = 'run-1'

const ok = (toolName: string, output: string): ExecutedToolResult => ({
  inputSummary: toolName,
  output,
  success: true,
  toolName,
})

const reportedFailure = (toolName: string, output: string): ExecutedToolResult => ({
  inputSummary: toolName,
  output,
  success: false,
  toolName,
})

/** A ledger over a fixed set of external names, for the tests that need no view. */
const ledgerOver = (
  prisma: PrismaClient,
  externalNames: ReadonlySet<string>,
  executeTool: (toolName: string, args: Record<string, unknown>, toolCallId: string) => Promise<ExecutedToolResult>,
) =>
  createToolEffectLedger(
    prisma,
    { isExternalDispatch: (toolName) => externalNames.has(toolName), runId: RUN_ID },
    { executeTool },
  )

test('a dispatch that THROWS leaves an unknown outcome, and the next execution reports it instead of repeating the call', async () => {
  const store = createEffectStore()
  let dispatches = 0
  const throwing = ledgerOver(store.prisma, new Set(['mail_send']), async () => {
    dispatches += 1
    // The shape of the real thing: an executor command that ran on the person's
    // machine and then lost its audit write, or an MCP call whose response never
    // came back. The tool reported nothing at all.
    throw new Error('connection reset after the request was sent')
  })

  await assert.rejects(
    () => throwing.executeTool('mail_send', {}, 'call-throw'),
    /connection reset/,
    'the throw still propagates — the ledger records, it does not swallow',
  )
  assert.equal(dispatches, 1)

  // The resumed execution: a new ledger over the same table, exactly as a
  // successor worker would build one.
  const resumed = ledgerOver(store.prisma, new Set(['mail_send']), async () => {
    dispatches += 1
    return ok('mail_send', 'sent')
  })
  const answer = await resumed.executeTool('mail_send', {}, 'call-throw')

  assert.equal(
    dispatches,
    1,
    'the call was NOT made a second time: a throw after the claim is an unknown outcome, not a durable failure',
  )
  assert.match(answer.output, /NOT known whether it took effect/)
  assert.match(answer.output, /not been repeated/)
  assert.equal(answer.success, false)
  assert.equal(
    store.row(RUN_ID, 'call-throw')?.state,
    TOOL_EFFECT_STATES.interrupted,
    'a throw settles `interrupted`, never `failed`: nothing was reported, so nothing is known',
  )
})

test('a dispatch that RETURNS a failure result records that failure and replays it, so no execution runs the call unclaimed', async () => {
  const store = createEffectStore()
  let dispatches = 0
  const first = ledgerOver(store.prisma, new Set(['ticket_create']), async () => {
    dispatches += 1
    return reportedFailure('ticket_create', 'the project rejected the ticket: no such column')
  })
  const failed = await first.executeTool('ticket_create', {}, 'call-reported')
  assert.equal(failed.success, false)
  assert.equal(
    store.row(RUN_ID, 'call-reported')?.state,
    TOOL_EFFECT_STATES.failed,
    'a failure the tool REPORTED is the only thing that writes `failed` — a throw never does',
  )

  // The state a later execution finds is the settled row, and it must answer
  // rather than fall through to the tool. A fall-through would run the call
  // WITHOUT a fresh claim: the settle is scoped to `dispatched`, so it would
  // match no row, the repeat would go unrecorded, and a third execution would
  // be free to run the same call a third time.
  const second = ledgerOver(store.prisma, new Set(['ticket_create']), async () => {
    dispatches += 1
    return ok('ticket_create', 'ticket NES-1 created')
  })
  const replayed = await second.executeTool('ticket_create', {}, 'call-reported')

  assert.equal(dispatches, 1, 'the call was not executed a second time')
  assert.equal(
    replayed.output,
    'the project rejected the ticket: no such column',
    'it was answered with the result the model already saw — the same answer the crash checkpoint gives on its fast path',
  )
  assert.equal(replayed.success, false)
  assert.equal(
    store.row(RUN_ID, 'call-reported')?.state,
    TOOL_EFFECT_STATES.failed,
    'and the row is unchanged: nothing was left in a state a further crash could repeat',
  )
})

test('a settled success is replayed rather than re-run', async () => {
  const store = createEffectStore()
  let dispatches = 0
  const first = ledgerOver(store.prisma, new Set(['ticket_create']), async () => {
    dispatches += 1
    return ok('ticket_create', 'ticket NES-1 created')
  })
  await first.executeTool('ticket_create', {}, 'call-ok')
  assert.equal(store.row(RUN_ID, 'call-ok')?.state, TOOL_EFFECT_STATES.completed)

  const second = ledgerOver(store.prisma, new Set(['ticket_create']), async () => {
    dispatches += 1
    return ok('ticket_create', 'ticket NES-2 created')
  })
  const replayed = await second.executeTool('ticket_create', {}, 'call-ok')
  assert.equal(dispatches, 1)
  assert.equal(replayed.output, 'ticket NES-1 created', 'the recorded result answered, not a second ticket')
})

test('an empty tool-call id is never claimed: the call falls through and cannot be answered from another call’s row', async () => {
  const store = createEffectStore()
  const seen: string[] = []
  const ledger = ledgerOver(store.prisma, new Set(['mail_send', 'ticket_create']), async (toolName) => {
    seen.push(toolName)
    return ok(toolName, `${toolName} ran`)
  })

  // Both calls arrive with the SAME missing id, which is what a provider that
  // omits ids actually produces. Claimed, they would land on one row and the
  // second would be answered from the first one's output.
  const first = await ledger.executeTool('mail_send', {}, '')
  const second = await ledger.executeTool('ticket_create', {}, '')
  const third = await ledger.executeTool('ticket_create', {}, '   ')

  assert.deepEqual(
    seen,
    ['mail_send', 'ticket_create', 'ticket_create'],
    'every id-less call ran: none was answered from another call’s row',
  )
  assert.equal(first.output, 'mail_send ran')
  assert.equal(
    second.output,
    'ticket_create ran',
    'the second call got its own result, not the mail the first call sent',
  )
  assert.equal(third.output, 'ticket_create ran', 'a whitespace-only id is no more of a key than an empty one')
  assert.equal(
    store.size(),
    0,
    'and nothing was claimed: an empty id is not a key, so there is no row to answer from',
  )
})

test('a reused tool-call id under a different tool name is reported as a collision, never answered from the wrong row', async () => {
  const store = createEffectStore()
  let mailSends = 0
  const first = ledgerOver(store.prisma, new Set(['mail_send', 'ticket_create']), async (toolName) => {
    if (toolName === 'mail_send') mailSends += 1
    return ok(toolName, `${toolName}: done`)
  })
  await first.executeTool('ticket_create', {}, 'call-shared')
  assert.equal(store.row(RUN_ID, 'call-shared')?.toolName, 'ticket_create')

  const collided = await first.executeTool('mail_send', {}, 'call-shared')

  assert.doesNotMatch(
    collided.output,
    /ticket_create: done/,
    'the mail call was NOT answered with the ticket call’s recorded output',
  )
  assert.equal(collided.success, false, 'nor handed the other call’s success')
  assert.equal(mailSends, 0, 'and it did not run: it cannot be told apart from the first')
  assert.match(collided.output, /cannot be told apart/)
  assert.match(collided.output, /distinct tool-call id/)
  assert.equal(
    store.row(RUN_ID, 'call-shared')?.toolName,
    'ticket_create',
    'the first call’s row is intact — the collision did not overwrite the guarantee it carries',
  )
})

test('the claim scope follows the live tool view: a name the run exposes mid-dispatch is claimed by a ledger built before it', async () => {
  const store = createEffectStore()
  // A stand-in for the mutable half of `mcp-toolset-deferred.ts`: what matters
  // is that the ledger reads the object, not a copy taken when it was built.
  const handledNames = new Set<string>(['mcp_find_tools'])
  const ledger = createToolEffectLedger(
    store.prisma,
    {
      isExternalDispatch: externalDispatchPredicate({
        executorToolset: { handledNames: new Set<string>() },
        mcpView: { handledNames },
      }),
      runId: RUN_ID,
    },
    { executeTool: async (toolName) => ok(toolName, `${toolName}: done`) },
  )

  handledNames.add('gh_create_issue')
  await ledger.executeTool('gh_create_issue', {}, 'call-late')

  assert.equal(
    store.row(RUN_ID, 'call-late')?.toolName,
    'gh_create_issue',
    'a set snapshotted at loop setup would have said “no claim” and dispatched it unclaimed',
  )

  handledNames.delete('gh_create_issue')
  await ledger.executeTool('gh_create_issue', {}, 'call-after-drop')
  assert.equal(
    store.row(RUN_ID, 'call-after-drop'),
    null,
    'and a name the view no longer handles is no longer this run’s external dispatch',
  )
})

test('the predicate over a real deferred MCP view claims every connector tool, loaded or not', async () => {
  const entries: McpToolEntry[] = ['create_page', 'send_message'].map((name, index) => ({
    connectorLabel: 'Probe',
    description: `Probe tool ${name}`,
    exposedName: `mcp_${name}`,
    inputSchema: { type: 'object', properties: {} },
    instanceId: `instance-${index}`,
    originalToolName: name,
    registryEntryId: `entry-${index}`,
  }))
  const view = buildDeferredView(entries, async () => ({
    inputSummary: '',
    output: 'dispatched',
    success: true,
  }))
  const isExternal = externalDispatchPredicate({
    executorToolset: { handledNames: new Set<string>() },
    mcpView: view,
  })

  assert.equal(
    isExternal('mcp_create_page'),
    true,
    'claimed before any load — the view dispatches a remembered name whether its schema is loaded or not',
  )
  await view.dispatch('mcp_load_tools', { names: ['mcp_create_page'] }, 'load-1')
  assert.equal(isExternal('mcp_create_page'), true, 'and still claimed once the run has loaded it')
  await view.dispatch('mcp_drop_tools', { names: ['mcp_create_page'] }, 'drop-1')
  assert.equal(isExternal('mcp_create_page'), true, 'and still claimed after the run drops the schema again')
  assert.equal(isExternal('kb_search'), false, 'a name the view never handles is not an external dispatch')
})

// A sub-agent's digest is model prose, not a status line: one assistant turn
// under `DELEGATE_BUDGET`, so a few kilobytes is the ordinary case and is what
// the row has to carry back intact.
const SUB_AGENT_DIGEST = [
  'Findings from the three docs pages and the two issues:',
  ...Array.from({ length: 400 }, (_, index) => `- finding ${index}: the connector rejects an empty cursor.`),
].join('\n')

test('a resumed run answers a completed `delegate` from the recorded digest instead of dispatching a second sub-agent', async () => {
  const store = createEffectStore()
  // Counting sub-agents is the whole point. A second one is not a duplicate of
  // one row: it is a fresh nested loop whose OWN effectful calls carry new
  // tool-call ids, matching no earlier claim, so nothing further down dedupes
  // them. The parent's `delegate` call is the only id that is stable across
  // executions, which is exactly why claiming it is what stops the repeat.
  let subAgents = 0
  // No external names: `delegate` is a builtin, so if it is claimed at all it
  // is claimed on its own declaration, never by the external-dispatch arm.
  const first = ledgerOver(store.prisma, new Set<string>(), async () => {
    subAgents += 1
    return ok('delegate', SUB_AGENT_DIGEST)
  })
  const dispatched = await first.executeTool('delegate', { task: 'read the changelog' }, 'call-delegate')

  assert.equal(subAgents, 1)
  assert.equal(dispatched.output, SUB_AGENT_DIGEST)

  // The successor worker: a new ledger over the same table, exactly as a
  // takeover builds one after the first execution died.
  const resumed = ledgerOver(store.prisma, new Set<string>(), async () => {
    subAgents += 1
    return ok('delegate', 'a second sub-agent went and did all of it again')
  })
  const replayed = await resumed.executeTool('delegate', { task: 'read the changelog' }, 'call-delegate')

  assert.equal(
    subAgents,
    1,
    'the delegation was NOT re-issued: no second sub-agent, so no second round of its side effects',
  )
  assert.equal(
    replayed.output,
    SUB_AGENT_DIGEST,
    'and the digest round-trips through the row byte for byte — the model reads what it read before, at full length',
  )
  assert.equal(replayed.success, true)
  assert.equal(replayed.toolCallId, 'call-delegate')
  assert.equal(
    store.row(RUN_ID, 'call-delegate')?.state,
    TOOL_EFFECT_STATES.completed,
    '`delegate` is claimed like any other tool whose effects leave the agent’s own workspace',
  )
})

test('a delegation whose execution died mid-dispatch is reported as unknown, never re-issued', async () => {
  const store = createEffectStore()
  let subAgents = 0
  const first = ledgerOver(store.prisma, new Set<string>(), async () => {
    subAgents += 1
    // The worker dies while the sub-agent is out sending mail: nothing ever
    // settles the claim.
    return new Promise<ExecutedToolResult>(() => undefined)
  })
  void first.executeTool('delegate', { task: 'send the summary' }, 'call-lost')
  await new Promise((resolve) => setImmediate(resolve))

  const resumed = ledgerOver(store.prisma, new Set<string>(), async () => {
    subAgents += 1
    return ok('delegate', 'the sub-agent sent a second copy of the summary')
  })
  const answer = await resumed.executeTool('delegate', { task: 'send the summary' }, 'call-lost')

  assert.equal(subAgents, 1, 'an unobserved delegation is never resolved by delegating again')
  assert.match(answer.output, /NOT known whether it took effect/)
  assert.equal(answer.success, false)
  assert.equal(
    store.row(RUN_ID, 'call-lost')?.state,
    TOOL_EFFECT_STATES.dispatched,
    'the claim it was answered from is a dispatch nothing ever settled',
  )
})

// ── `spawn_subtask`: the same flag, and durable rows a person can see ───────
//
// The delegate tests above count sub-agents, because a delegation's sub-agent
// is transient — a nested loop that leaves nothing behind but its digest. A
// spawn's child is not. `runSpawnSubtaskTool` commits a child `Agent`, its
// `Run` and its `Task` in one transaction and enqueues that run, so a re-issued
// call leaves a second agent in the agent list and a second task on the board:
// the failure a user would report as a bug.
//
// Nothing collapses a second call onto the first. The child's name embeds a
// fresh `randomUUID().slice(0, 8)`, so there is no natural key, and the
// enqueue's idempotency key is `subtask:<parent run>:<CHILD agent id>` — built
// from the id the second creation just minted, so the queue's
// `ON CONFLICT DO NOTHING` matches nothing either. The store below models that
// conflict faithfully rather than assuming it, so the assertions are on the
// rows themselves.

const SUBTASK_FIXTURE = {
  agentId: '00000000-0000-4000-8000-0000000000a1',
  channelId: '00000000-0000-4000-8000-0000000000a2',
  messageId: '00000000-0000-4000-8000-0000000000a3',
  organizationId: '00000000-0000-4000-8000-0000000000a4',
  threadId: '00000000-0000-4000-8000-0000000000a5',
} as const

const createSubtaskWorld = () => {
  const effects = createEffectStore()
  const agents: Array<{ id: string; name: string }> = []
  const runs: Array<{ id: string; threadId: string }> = []
  const tasks: Array<{ id: string }> = []
  const enqueuedKeys: string[] = []

  const tx = {
    // `enqueueQueueJob`'s insert. Its idempotency key is the only thing
    // besides this ledger that could collapse a repeat, so its
    // `ON CONFLICT DO NOTHING` is modelled here rather than assumed away.
    $executeRaw: async (query: unknown) => {
      const values = (query as { values?: unknown[] }).values ?? []
      const key = values.find(
        (value): value is string => typeof value === 'string' && value.startsWith('subtask:'),
      )
      if (key === undefined) return 1
      if (enqueuedKeys.includes(key)) return 0
      enqueuedKeys.push(key)
      return 1
    },
    agent: {
      create: async ({ data }: { data: { name: string } }) => {
        const row = { id: randomUUID(), name: data.name }
        agents.push(row)
        return row
      },
    },
    run: {
      create: async () => {
        const row = { id: randomUUID(), threadId: SUBTASK_FIXTURE.threadId }
        runs.push(row)
        return row
      },
    },
    task: {
      create: async () => {
        const row = { id: randomUUID() }
        tasks.push(row)
        return row
      },
    },
  }

  const prisma = {
    $transaction: async <T>(work: (client: typeof tx) => Promise<T>) => work(tx),
    agent: {
      findUnique: async () => ({
        effort: 'medium',
        id: SUBTASK_FIXTURE.agentId,
        model: 'model',
        name: 'Parent',
        ownerUserId: null,
        provider: 'provider',
        systemPrompt: 'Prompt',
        // No policy, so the run never reaches `stripProtectedExplicitToolPolicy`
        // — grant projection is `subtask-tools.test.ts`'s subject, not this
        // one's.
        toolPolicy: null,
        visibility: 'team',
      }),
    },
    // No plan on this run, so no delegation step: the three rows below are the
    // ones the transaction always writes.
    plan: { findFirst: async () => null },
    runToolEffect: effects.runToolEffect,
  } as unknown as PrismaClient

  const context = {
    actorContext: {
      actionContext: { requestId: 'subtask-ledger' },
      actor: { actorId: SUBTASK_FIXTURE.agentId, actorType: 'agent', roles: [] },
      tenant: { organizationId: SUBTASK_FIXTURE.organizationId },
    },
    agentId: SUBTASK_FIXTURE.agentId,
    agentKind: 'shared',
    channel: {
      id: SUBTASK_FIXTURE.channelId,
      organizationId: SUBTASK_FIXTURE.organizationId,
    },
    prisma,
    realtimeTransport: { publishWs: async () => undefined },
    run: {
      id: RUN_ID,
      messageId: SUBTASK_FIXTURE.messageId,
      threadId: SUBTASK_FIXTURE.threadId,
    },
  } as unknown as BuiltinToolRuntimeContext

  /** The real handler behind the seam, exactly as `tools.ts` calls it. */
  const spawn = async (
    _toolName: string,
    args: Record<string, unknown>,
  ): Promise<ExecutedToolResult> => {
    const result = await runSpawnSubtaskTool(context, { role: args['role'], task: args['task'] })
    return {
      inputSummary: result.inputSummary,
      output: result.outputPreview,
      success: true,
      toolName: result.toolName,
    }
  }

  return { agents, effects, enqueuedKeys, prisma, runs, spawn, tasks }
}

test('a resumed run answers a completed `spawn_subtask` from its row — no second child agent, task or run', async () => {
  const world = createSubtaskWorld()
  const args = { role: 'researcher', task: 'chase the shipping regression' }

  const first = ledgerOver(world.prisma, new Set<string>(), world.spawn)
  const dispatched = await first.executeTool('spawn_subtask', args, 'call-spawn')

  assert.equal(world.agents.length, 1)
  assert.equal(world.runs.length, 1)
  assert.equal(world.tasks.length, 1)
  assert.deepEqual(
    world.enqueuedKeys,
    [`subtask:${RUN_ID}:${world.agents[0]?.id}`],
    'the queue key is built from the child id this call just minted — which is why a repeat would not collide with it',
  )
  assert.match(dispatched.output, /Spawned researcher sub-agent\./)

  // The successor worker: a new ledger over the same table, exactly as a
  // takeover builds one after the first execution died.
  const resumed = ledgerOver(world.prisma, new Set<string>(), world.spawn)
  const replayed = await resumed.executeTool('spawn_subtask', args, 'call-spawn')

  // The rows are the damage, so the rows are what is asserted. A second agent
  // would show up in the agent list, a second task on the board, and a second
  // run would go and do the work again.
  assert.equal(world.agents.length, 1, 'no second child agent was minted')
  assert.equal(world.runs.length, 1, 'and no second run')
  assert.equal(world.tasks.length, 1, 'and no second task on the board')
  assert.equal(world.enqueuedKeys.length, 1, 'and the work was dispatched once')

  assert.equal(
    replayed.output,
    dispatched.output,
    'the model reads back exactly what it read before — the same child, not a stranger',
  )
  assert.ok(
    replayed.output.includes(`agentId=${world.agents[0]?.id}`),
    'and the digest still names the child that actually exists',
  )
  assert.equal(replayed.success, true)
  assert.equal(replayed.toolCallId, 'call-spawn')
  assert.equal(
    world.effects.row(RUN_ID, 'call-spawn')?.state,
    TOOL_EFFECT_STATES.completed,
    '`spawn_subtask` is claimed like any other tool whose effects outlive the run',
  )
})
