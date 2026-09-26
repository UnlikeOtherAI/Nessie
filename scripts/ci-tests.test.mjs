import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { parse } from 'yaml'
import { TEST_LEGS, legPackages, runLeg, runTests, shardedScript, testPlan, validateDatabases } from './ci-tests.mjs'

const env = {
  DATABASE_URL: 'postgresql://user:password@localhost:5432/api_tests',
  WORKER_TEST_DATABASE_URL: 'postgresql://user:password@localhost:5432/worker_tests',
}
const graph = { tasks: [
  { package: '@nessie/api', task: 'test', command: 'node --test' },
  { package: '@nessie/worker', task: 'test', command: 'node --test' },
  { package: '@nessie/runtime', task: 'test', command: 'node --test' },
  { package: '@nessie/empty', task: 'test', command: '<NONEXISTENT>' },
  { package: '@nessie/runtime', task: 'build', command: 'tsc' },
] }

test('preserves dependency-added tests and builds from the original Turbo graph', () => {
  const plan = testPlan(graph)
  assert.deepEqual(plan.builds, ['@nessie/runtime'])
  assert.deepEqual(plan.groups.flatMap((group) => group.packages).sort(),
    ['@nessie/api', '@nessie/runtime', '@nessie/worker'])
  assert.equal(plan.groups.reduce((sum, group) => sum + group.concurrency, 0), 4)
})

test('never runs overlapping suites on the same database, including host aliases', () => {
  for (const value of [undefined, env.DATABASE_URL, 'postgres://other@127.0.0.1/api_tests?schema=other']) {
    assert.throws(() => validateDatabases({ ...env, WORKER_TEST_DATABASE_URL: value }))
  }
  assert.doesNotThrow(() => validateDatabases(env))
})

test('finishes all builds before overlapping test groups and isolates worker', async () => {
  let built = false
  let release
  const barrier = new Promise((resolve) => { release = resolve })
  const started = []
  await runTests({ graph, env, run: async (args, childEnv) => {
    if (args[0] === 'build') { built = true; return }
    assert.equal(built, true)
    assert.ok(args.includes('--only'))
    const worker = args.includes('--filter=@nessie/worker')
    assert.equal(childEnv.DATABASE_URL, worker ? env.WORKER_TEST_DATABASE_URL : env.DATABASE_URL)
    started.push(args)
    if (started.length === 3) release()
    await barrier
  } })
  assert.equal(started.length, 3)
})

test('build failure starts no tests; group failure still waits for the other suites', async () => {
  const calls = []
  await assert.rejects(runTests({ graph, env, run: async (args) => {
    calls.push(args[0]); throw new Error('compile error')
  } }))
  assert.deepEqual(calls, ['build'])
  let completed = 0
  await assert.rejects(runTests({ graph, env, run: async (args) => {
    if (args[0] === 'build') return
    if (args.includes('--filter=@nessie/api')) throw new Error('assertion failed')
    await new Promise((resolve) => setImmediate(resolve))
    completed++
  } }))
  assert.equal(completed, 2)
})

test('each leg draws its packages from its planned group; an out-of-scope leg has none', () => {
  const plan = testPlan(graph)
  assert.deepEqual(legPackages(plan, 'api'), ['@nessie/api'])
  assert.deepEqual(legPackages(plan, 'worker-unit'), ['@nessie/worker'])
  assert.deepEqual(legPackages(plan, 'worker-db'), ['@nessie/worker'])
  assert.deepEqual(legPackages(plan, 'other'), ['@nessie/runtime'])
  assert.deepEqual(legPackages(testPlan({ tasks: [] }), 'api'), [])
  assert.throws(() => legPackages(plan, 'desktop'), /Unknown CI test leg/)
})

test('a shard goes only into a plain node --test script, and only a valid one', () => {
  assert.equal(
    shardedScript('node --test --import tsx "test/**/*.test.ts"', '2/3'),
    'node --test --test-shard=2/3 --import tsx "test/**/*.test.ts"',
  )
  assert.equal(shardedScript('node --test x', undefined), 'node --test x')
  assert.throws(() => shardedScript('pnpm run test:unit && pnpm run test:db', '1/2'), /plain "node --test"/)
  for (const shard of ['0/2', '3/2', '1', 'a/b']) {
    assert.throws(() => shardedScript('node --test x', shard), /Invalid test shard/)
  }
})

test('a script leg builds its closure, then runs its sharded script in the package', async () => {
  const legGraph = { tasks: [
    { package: '@nessie/api', task: 'test', command: 'node --test', directory: 'api' },
    { package: '@nessie/runtime', task: 'build', command: 'tsc' },
  ] }
  const calls = []
  const ran = await runLeg({
    env,
    graph: legGraph,
    leg: 'api',
    packages: ['@nessie/api'],
    run: async (args) => { calls.push(['turbo', ...args]) },
    runScript: async (directory, script) => { calls.push(['script', directory, script]) },
    scripts: () => ({ test: 'node --test --import tsx "test/**/*.test.ts"' }),
    shard: '1/3',
  })
  assert.equal(ran, true)
  assert.deepEqual(calls, [
    ['turbo', 'build', '--concurrency=4', '--filter=@nessie/runtime'],
    ['script', 'api', 'node --test --test-shard=1/3 --import tsx "test/**/*.test.ts"'],
  ])
})

test('the other leg tests its packages through Turbo and cannot be sharded', async () => {
  const calls = []
  const unexpected = async () => { throw new Error('unexpected') }
  await runLeg({
    env, graph: { tasks: [] }, leg: 'other', packages: ['@nessie/runtime'],
    run: async (args) => { calls.push(args) }, runScript: unexpected, scripts: () => ({}),
  })
  assert.deepEqual(calls, [['test', '--only', '--continue', '--concurrency=2', '--filter=@nessie/runtime']])
  await assert.rejects(runLeg({
    env, graph: { tasks: [] }, leg: 'other', packages: ['@nessie/runtime'], shard: '1/2',
    run: async () => {}, runScript: unexpected, scripts: () => ({}),
  }), /cannot be sharded/)
})

test('a leg with nothing in scope builds and runs nothing', async () => {
  const unexpected = async () => { throw new Error('unexpected') }
  const ran = await runLeg({
    env, graph: { tasks: [] }, leg: 'worker-db', packages: [], shard: '1/2',
    run: unexpected, runScript: unexpected, scripts: () => ({}),
  })
  assert.equal(ran, false)
})

// The matrix in ci.yml and TEST_LEGS must agree: every leg known, every
// sharded suite covered by each of its shards exactly once, and the required
// `Test` check standing for all of them — including a cancelled or failed leg.
test('the workflow runs every leg once, every shard once, behind the Test check', async () => {
  const ci = parse(await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'))
  const byGroup = new Map()
  for (const entry of ci.jobs['test-legs'].strategy.matrix.include) {
    assert.ok(TEST_LEGS[entry.group], `unknown test leg ${entry.group}`)
    byGroup.set(entry.group, [...(byGroup.get(entry.group) ?? []), entry.shard ?? ''])
  }
  assert.deepEqual([...byGroup.keys()].sort(), Object.keys(TEST_LEGS).sort())
  for (const [group, shards] of byGroup) {
    if (!TEST_LEGS[group].shardable || shards.every((shard) => shard === '')) {
      assert.deepEqual(shards, [''], `${group} runs once, unsharded`)
      continue
    }
    const total = Number(shards[0].split('/')[1])
    assert.deepEqual(shards.slice().sort(), Array.from({ length: total }, (_, i) => `${i + 1}/${total}`), `${group} shards`)
  }
  assert.equal(ci.jobs.test.name, 'Test')
  assert.equal(ci.jobs.test.needs, 'test-legs')
  assert.equal(ci.jobs.test.if, 'always()')
})
