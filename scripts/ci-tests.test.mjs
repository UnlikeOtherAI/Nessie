import assert from 'node:assert/strict'
import test from 'node:test'
import { runTests, testPlan, validateDatabases } from './ci-tests.mjs'

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
