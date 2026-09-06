import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ADMIN_PORT, ADMIN_URL } from '../navigation/lib/config.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const adminRoot = resolve(here, '..', '..')
const repoRoot = resolve(adminRoot, '..')
const vite = resolve(repoRoot, 'node_modules', '.bin', 'vite')

// The port is decided in one place for every browser suite
// (`../navigation/lib/config.mjs`), so `NAV_E2E_ADMIN_PORT` moves this suite
// off 5455 exactly as it moves the others.
export const adminUrl = ADMIN_URL

// Which checkout is on the port. Nothing in the response says: every checkout
// serves the same `index.html` and the same `@vite/client`, and a foreign
// server will happily serve this worktree's files if they sit inside its own
// root. What does distinguish them is Vite's file-serving boundary — it
// answers `/@fs/<absolute path>` with 403 when the file **exists** and lies
// outside the server's workspace root, and otherwise falls through to the SPA
// fallback. So the question is not "can you read this" but "do you refuse what
// you should not reach", and pinning the root down takes two probes:
//
//   - a file inside this worktree must be SERVED. Another worktree's server
//     refuses it: sibling roots do not contain each other.
//   - a file in the nearest package *above* this worktree must be REFUSED.
//     Worktrees live under `<repo>/.claude/worktrees/`, so a dev server
//     started from the main checkout contains this one and would pass the
//     first probe on containment alone.
//
// Both name files that really exist, because the 403 is what carries the
// signal and Vite answers a path it cannot find with index.html either way.
const servedProbe = resolve(adminRoot, 'package.json')

const nearestPackageAbove = () => {
  let directory = dirname(repoRoot)
  for (;;) {
    const candidate = resolve(directory, 'package.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(directory)
    // A checkout that is not nested inside another package — CI, and any
    // ordinary clone — has nothing above it to be confused with, so the first
    // probe stands alone.
    if (parent === directory) return null
    directory = parent
  }
}

const refusedProbe = nearestPackageAbove()

const probeStatus = async (absolutePath) => {
  try {
    const response = await fetch(`${adminUrl}/@fs/${absolutePath}`, {
      signal: AbortSignal.timeout(2_000),
    })
    return response.status
  } catch {
    return 0
  }
}

/**
 * Who owns the port right now.
 *
 * - `unreachable` — nothing is listening; this run starts its own server.
 * - `ours` — this worktree's Vite dev server; adopt it, which is what keeps
 *   the suite from fighting a local `pnpm dev`.
 * - `foreign` — something else answers. Historically that was adopted too, on
 *   the strength of `@vite/client` alone: a second worktree's dev server
 *   passes that test, and the suite then rendered *its* branch and reported
 *   the result as if it were this one's.
 */
const identify = async () => {
  let index
  try {
    index = await fetch(adminUrl, { signal: AbortSignal.timeout(1_000) })
  } catch {
    return 'unreachable'
  }
  // The suite needs Vite's real development server rather than a static
  // preview, and this also verifies the project's required HMR client is
  // present before the browser starts exercising the production shell.
  if (!index.ok || !(await index.text()).includes('@vite/client')) return 'foreign'
  if (await probeStatus(servedProbe) !== 200) return 'foreign'
  if (refusedProbe && await probeStatus(refusedProbe) !== 403) return 'foreign'
  return 'ours'
}

const waitForOurs = async (timeout = 60_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await identify() === 'ours') return true
    await new Promise((done) => setTimeout(done, 200))
  }
  return false
}

const occupiedMessage = () => [
  `Port ${ADMIN_PORT} is answering, but not from this worktree.`,
  'This suite used to adopt whatever served @vite/client there, so a second',
  "worktree's `pnpm dev` made it render that checkout and report the result as",
  'this one — a pass or a failure belonging to somebody else\'s branch.',
  'Stop that server, or give this run its own port:',
  `  NAV_E2E_ADMIN_PORT=<free port> pnpm --filter @nessie/admin test:e2e:connected-mail`,
].join('\n')

export const startAdmin = async () => {
  const owner = await identify()
  if (owner === 'ours') return { adopted: true, stop: async () => {} }
  if (owner === 'foreign') throw new Error(occupiedMessage())
  if (!existsSync(vite)) throw new Error('Vite is missing — run pnpm install first.')
  const child = spawn(vite, ['--port', String(ADMIN_PORT), '--strictPort'], {
    cwd: adminRoot, detached: true, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = []
  child.stdout.on('data', (chunk) => output.push(String(chunk)))
  child.stderr.on('data', (chunk) => output.push(String(chunk)))
  if (!await waitForOurs()) {
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* process already exited */ }
    throw new Error(`Vite did not start on ${ADMIN_PORT}:\n${output.join('').slice(-3_000)}`)
  }
  return {
    adopted: false,
    stop: async () => {
      if (child.exitCode !== null) return
      try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
    },
  }
}
