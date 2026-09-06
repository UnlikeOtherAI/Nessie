import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma, type PrismaClient } from '@prisma/client'

import { buildDeferredView } from '../mcp-toolset-deferred.js'
import type { McpToolEntry } from '../mcp-toolset.js'
import type { ExecutedToolResult } from '../tool-batch.js'
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
