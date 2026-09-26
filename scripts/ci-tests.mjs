// Build the original Turbo test graph once, then overlap API and worker only
// when their databases are explicitly isolated. Ordinary pnpm test stays serial.
//
// CI splits the suites across runners instead (`CI_TEST_GROUP`, one leg of the
// Test matrix): the API suite, the worker's unit and database suites, and every
// other package. One runner held all of them and took 25-31 minutes, 18 of
// them the API suite and 21 the worker's. A leg builds only its own closure,
// runs against its own database, and `CI_TEST_SHARD` (`i/n`) splits the API
// and worker database suites further with Node's --test-shard.
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function testPlan(graph) {
  const tasks = graph.tasks.filter((task) => task.command && task.command !== '<NONEXISTENT>')
  const packages = [...new Set(tasks.filter((task) => task.task === 'test').map((task) => task.package))]
  return {
    builds: [...new Set(tasks.filter((task) => task.task === 'build').map((task) => task.package))],
    groups: [
      { name: 'worker', packages: packages.filter((name) => name === '@nessie/worker'), concurrency: 1 },
      { name: 'api', packages: packages.filter((name) => name === '@nessie/api'), concurrency: 1 },
      { name: 'other', packages: packages.filter((name) => !['@nessie/api', '@nessie/worker'].includes(name)), concurrency: 2 },
    ].filter((group) => group.packages.length),
  }
}

export function validateDatabases(env) {
  const identity = (value) => {
    if (!value) throw new Error('DATABASE_URL and WORKER_TEST_DATABASE_URL are required')
    let url
    try { url = new URL(value) } catch { throw new Error('Invalid test database URL') }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.pathname.length < 2) {
      throw new Error('Test databases must be named PostgreSQL databases')
    }
    // Require distinct database names even across host aliases/proxies.
    return decodeURIComponent(url.pathname)
  }
  if (identity(env.DATABASE_URL) === identity(env.WORKER_TEST_DATABASE_URL)) {
    throw new Error('Worker and API tests require different database names')
  }
}

export async function runTests({ graph, env, run }) {
  validateDatabases(env)
  const plan = testPlan(graph)
  const filters = (packages) => packages.map((name) => `--filter=${name}`)
  if (plan.builds.length) {
    await run(['build', '--concurrency=4', ...filters(plan.builds)], env)
  }
  // --only is safe only here: the complete original graph's builds finished,
  // and the worker gets an exclusive database. Never compile during tests.
  const results = await Promise.allSettled(plan.groups.map((group) => run([
    'test', '--only', '--continue', `--concurrency=${group.concurrency}`, ...filters(group.packages),
  ], { ...env, DATABASE_URL: group.name === 'worker' ? env.WORKER_TEST_DATABASE_URL : env.DATABASE_URL })))
  if (results.some((result) => result.status === 'rejected')) throw new Error('One or more test groups failed')
}

/**
 * The CI test legs: which planned group each draws its packages from, and —
 * for a leg that runs one package's script directly rather than through Turbo
 * — which script, and whether it may be sharded.
 */
export const TEST_LEGS = {
  api: { group: 'api', script: 'test', shardable: true },
  'worker-unit': { group: 'worker', script: 'test:unit', shardable: false },
  'worker-db': { group: 'worker', script: 'test:db', shardable: true },
  other: { group: 'other', shardable: false },
}

/** The packages one leg runs, from the full scoped plan; empty when the scope left it nothing. */
export function legPackages(plan, leg) {
  const definition = TEST_LEGS[leg]
  if (!definition) throw new Error(`Unknown CI test leg "${leg}"`)
  return plan.groups.find((group) => group.name === definition.group)?.packages ?? []
}

/**
 * A package script with Node's test shard inserted. Only a script that is a
 * plain `node --test` invocation can be split, so a script that grows another
 * shape fails the leg loudly instead of silently running everything n times.
 */
export function shardedScript(script, shard) {
  if (!shard) return script
  if (!/^[1-9]\d*\/[1-9]\d*$/.test(shard)) throw new Error(`Invalid test shard "${shard}"`)
  const [index, total] = shard.split('/').map(Number)
  if (index > total) throw new Error(`Invalid test shard "${shard}"`)
  if (!script?.startsWith('node --test ')) {
    throw new Error(`Cannot shard "${script}": the script must be a plain "node --test" invocation`)
  }
  return script.replace(/^node --test /, `node --test --test-shard=${shard} `)
}

/**
 * Run one leg: build what its tests need, then test. `graph` is the dry run
 * narrowed to the leg's packages, so the builds are exactly its closure.
 * Returns false when the scope left the leg nothing to run.
 */
export async function runLeg({ leg, shard, packages, graph, scripts, env, run, runScript }) {
  const definition = TEST_LEGS[leg]
  if (!definition) throw new Error(`Unknown CI test leg "${leg}"`)
  if (shard && !definition.shardable) throw new Error(`The ${leg} leg cannot be sharded`)
  if (!packages.length) return false
  const filters = (names) => names.map((name) => `--filter=${name}`)
  const builds = testPlan(graph).builds
  if (builds.length) await run(['build', '--concurrency=4', ...filters(builds)], env)
  if (!definition.script) {
    await run(['test', '--only', '--continue', '--concurrency=2', ...filters(packages)], env)
    return true
  }
  const [name] = packages
  const directory = graph.tasks.find((task) => task.package === name && task.task === 'test')?.directory
  if (!directory) throw new Error(`No test task for ${name} in the leg's graph`)
  await runScript(directory, shardedScript(scripts(name, directory)[definition.script], shard), env)
  return true
}

function turbo(args, env, capture = false) {
  return new Promise((resolve, reject) => {
    // Calling the JS entry avoids shell quoting and Windows .cmd spawning.
    const child = spawn(process.execPath, ['node_modules/turbo/bin/turbo', 'run', ...args], {
      env, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    })
    let output = ''
    if (capture) child.stdout.on('data', (chunk) => { output += chunk })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve(output) : reject(new Error(`Turbo ${args[0]} failed (${code})`)))
  })
}

// A package script run the way `pnpm run` would, in its package directory.
function packageScript(directory, script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['--dir', directory, 'exec', 'sh', '-c', script], { env, stdio: 'inherit' })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`"${script}" failed (${code})`)))
  })
}

async function mainLeg(leg, env) {
  const shard = env.CI_TEST_SHARD?.trim() || undefined
  const scope = (env.TURBO_SCOPE ?? '').split(/\s+/).filter(Boolean)
  const plan = testPlan(JSON.parse(await turbo(['test', ...scope, '--dry-run=json'], env, true)))
  const packages = legPackages(plan, leg)
  if (!packages.length) {
    console.log(`No ${leg} tests are in this change's scope; nothing to run.`)
    return
  }
  const graph = JSON.parse(await turbo(['test', ...packages.map((name) => `--filter=${name}`), '--dry-run=json'], env, true))
  const manifests = new Map()
  for (const task of graph.tasks.filter((entry) => entry.task === 'test' && packages.includes(entry.package))) {
    manifests.set(task.package, JSON.parse(await readFile(join(task.directory, 'package.json'), 'utf8')).scripts ?? {})
  }
  await runLeg({
    env,
    graph,
    leg,
    packages,
    run: turbo,
    runScript: packageScript,
    scripts: (name) => manifests.get(name) ?? {},
    shard,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const leg = process.env.CI_TEST_GROUP?.trim()
    if (leg) {
      await mainLeg(leg, process.env)
    } else {
      validateDatabases(process.env)
      const scope = (process.env.TURBO_SCOPE ?? '').split(/\s+/).filter(Boolean)
      const graph = JSON.parse(await turbo(['test', ...scope, ...process.argv.slice(2), '--dry-run=json'], process.env, true))
      await runTests({ graph, env: process.env, run: turbo })
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
