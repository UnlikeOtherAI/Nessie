import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExecutionDependencies } from '../run/execute/types.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

dbTest('the real processor transport commits ordered results, dependencies and one artifact without a receiver', async (t) => {
  const { createMockLlmServer, parseScenario } = await import('@nessie/mock-llm')
  const server = await createMockLlmServer({ scenario: parseScenario({
    name: 'task-set-results', turns: [{ text: '{"summary":"完成"}', usage: { inputTokens: 12, outputTokens: 8 } }],
  }) })
  t.after(() => server.close())
  const values = { NESSIE_MODEL_PROVIDER: 'openai', NESSIE_MODEL_API_KEY: 'mock-token',
    OPENAI_API_KEY: 'mock-token', NESSIE_MODEL_BASE_URL: `${server.url}/v1` }
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key]
    process.env[key] = value
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous })
  }
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = []
  const fetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    assert.ok(url.startsWith(server.url), 'processor tests must never contact a real provider')
    if (typeof init?.body === 'string') requests.push(JSON.parse(init.body) as typeof requests[number])
    return fetch(input, init)
  }
  t.after(() => { globalThis.fetch = fetch })
  // The production inference factory captures its config at module load.
  const { executeTaskSet } = await import('./execute.js')
  const { taskSetFinalizationFixture } = await import('./finalization-fixture.js')
  const fixture = async (context: Parameters<typeof taskSetFinalizationFixture>[0], count = 1) => {
    const f = await taskSetFinalizationFixture(context, 0)
    await f.prisma.taskSet.update({ where: { id: f.set.id }, data: {
      processor: { provider: 'openai', model: 'mock-model' }, totalItems: count, nextSequence: 1,
    } })
    const first = await f.prisma.taskSetItem.create({ data: {
      taskSetId: f.set.id, sequence: 1, clientKey: 'one', prompt: 'Shrň tenhle záznam prosím.',
      input: { label: 'První řádek' }, disclosure: f.disclosure,
    } })
    // No realtime or secondary model activity is allowed in this deterministic lane.
    const unused = new Proxy({}, { get: () => { throw new Error('Unexpected secondary service') } })
    const deps = { ...f.deps, modelClient: unused, queueProvider: unused,
      realtimeTransport: unused, searchConfig: unused } as typeof f.deps & ExecutionDependencies
    return { ...f, first, deps }
  }
  const f = await fixture(t, 2)
  await f.prisma.taskSet.update({ where: { id: f.set.id }, data: {
    output: { kind: 'documents', spaceId: f.space.id, format: 'jsonl' },
  } })
  const second = await f.prisma.taskSetItem.create({ data: {
    taskSetId: f.set.id, sequence: 2, clientKey: 'two', prompt: 'navaz na první výsledek',
    input: { label: '第二行' }, dependencies: [f.first.id], disclosure: f.disclosure,
  } })
  await executeTaskSet(f.deps, f.set.id)
  const afterFirst = await f.prisma.taskSet.findUniqueOrThrow({ where: { id: f.set.id } })
  assert.equal(afterFirst.nextSequence, 2, afterFirst.reason ?? 'first item must complete')
  assert.equal(afterFirst.completedItems, 1)
  assert.equal((await f.prisma.taskSetItem.findUniqueOrThrow({ where: { id: second.id } })).status, 'pending')
  await executeTaskSet(f.deps, f.set.id)
  assert.equal(server.stats().requests, 2)
  const input = JSON.parse(requests[1]!.messages.find((message) => message.role === 'user')!.content) as {
    dependencies: Array<{ id: string; result: string }>;
  }
  assert.deepEqual(input.dependencies, [{ id: f.first.id, sequence: 1, result: '{"summary":"完成"}' }])
  await executeTaskSet(f.deps, f.set.id)
  await executeTaskSet(f.deps, f.set.id)
  const completed = await f.prisma.taskSet.findUniqueOrThrow({ where: { id: f.set.id } })
  assert.equal(completed.status, 'completed')
  assert.equal(completed.deliveryStatus, 'none')
  assert.ok(completed.outputPageId)
  assert.equal(f.stored(), 1)
  assert.equal(server.stats().requests, 2)
  assert.equal(await f.prisma.agentMailboxMessage.count({ where: { taskSetId: f.set.id } }), 0)
  const runs = await f.prisma.run.findMany({ where: { threadId: f.thread.id }, select: { id: true } })
  assert.equal(await f.prisma.tokenLedgerEvent.count({ where: { runId: { in: runs.map((run) => run.id) } } }), 2)

  await t.test('oversized context blocks before dispatch and retains the row', async (context) => {
    const large = await fixture(context)
    await large.prisma.taskSetItem.update({ where: { id: large.first.id }, data: { input: '文'.repeat(10_000) } })
    await executeTaskSet(large.deps, large.set.id)
    const blocked = await large.prisma.taskSet.findUniqueOrThrow({ where: { id: large.set.id } })
    assert.equal(blocked.reason, 'input_too_large')
    assert.equal(blocked.nextSequence, 1)
    assert.equal(server.stats().requests, 2)
  })
  await t.test('invalid mapped result blocks its item before final artifact creation', async (context) => {
    const mapped = await fixture(context)
    await mapped.prisma.taskSet.update({ where: { id: mapped.set.id }, data: {
      output: { kind: 'spreadsheet', spaceId: mapped.space.id, fields: { Missing: 'missing' } },
    } })
    await executeTaskSet(mapped.deps, mapped.set.id)
    const blocked = await mapped.prisma.taskSet.findUniqueOrThrow({ where: { id: mapped.set.id } })
    assert.equal(blocked.reason, 'invalid_mapping')
    assert.equal(blocked.nextSequence, 1)
    assert.equal(mapped.stored(), 0)
    assert.equal(server.stats().requests, 3)
  })
})
