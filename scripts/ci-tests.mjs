// Build the original Turbo test graph once, then overlap API and worker only
// when their databases are explicitly isolated. Ordinary pnpm test stays serial.
import { spawn } from 'node:child_process'
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    validateDatabases(process.env)
    const scope = (process.env.TURBO_SCOPE ?? '').split(/\s+/).filter(Boolean)
    const graph = JSON.parse(await turbo(['test', ...scope, ...process.argv.slice(2), '--dry-run=json'], process.env, true))
    await runTests({ graph, env: process.env, run: turbo })
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
