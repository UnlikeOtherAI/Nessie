// Bring up the two servers the suite drives: the API on 5454 and the admin
// on 5455. Both are started as their own process group so a kill takes the
// whole tree down, and both are waited on by polling a real URL rather than
// by sleeping.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  ADMIN_PORT,
  ADMIN_ROOT,
  ADMIN_URL,
  API_PORT,
  API_URL,
  REPO_ROOT,
  adminMode,
  databaseUrl,
} from './config.mjs'

const BIN = resolve(REPO_ROOT, 'node_modules', '.bin')

export const waitForUrl = async (url, { label, timeoutMs = 120_000 }) => {
  const deadline = Date.now() + timeoutMs
  let lastError = 'no attempt made'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'manual' })
      if (response.status < 500) {
        await response.arrayBuffer()
        return
      }
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise((done) => { setTimeout(done, 250) })
  }
  throw new Error(`${label} never became ready at ${url} (${lastError})`)
}

const startProcess = ({ args, command, cwd, env, label }) => {
  if (!existsSync(command)) {
    throw new Error(`${label} cannot start: ${command} is missing — run pnpm install first`)
  }
  const child = spawn(command, args, {
    cwd,
    detached: true,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const log = []
  const record = (chunk) => {
    const text = String(chunk)
    log.push(text)
    if (process.env.NAV_E2E_SERVER_LOGS === '1') process.stdout.write(`[${label}] ${text}`)
  }
  child.stdout.on('data', record)
  child.stderr.on('data', record)
  const exited = new Promise((done) => { child.on('exit', (code) => done(code)) })
  return { child, exited, label, log, output: () => log.join('') }
}

// A server already answering on its port is used as-is. That is the local
// `pnpm dev` case, and it keeps the suite from fighting the dev loop for
// 5454/5455 (both are strict-port by policy).
const alreadyRunning = async (url) => {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2_000) })
    await response.arrayBuffer()
    return response.status < 500
  } catch {
    return false
  }
}

const adopted = (label) => ({
  child: { exitCode: null, pid: null },
  exited: Promise.resolve(0),
  label,
  log: [],
  output: () => '',
})

export const stopProcess = async (server) => {
  if (!server?.child.pid || server.child.exitCode !== null) return
  try {
    process.kill(-server.child.pid, 'SIGTERM')
  } catch {
    try { server.child.kill('SIGTERM') } catch { /* already gone */ }
  }
  await Promise.race([
    server.exited,
    new Promise((done) => { setTimeout(done, 5_000) }),
  ])
  try { process.kill(-server.child.pid, 'SIGKILL') } catch { /* already gone */ }
}

// The API is started directly through tsx rather than through its `dev`
// script: nodemon's `--env-file=../.env` requires a .env that CI does not
// have. Local mode keeps the embedded worker and the localhost dev-login
// route, which is one of the suite's two ways in.
export const startApi = async () => {
  if (await alreadyRunning(`${API_URL}/api/health`)) {
    console.log(`navigation e2e: using the API already listening on ${API_URL}`)
    return adopted('api')
  }
  const database = databaseUrl()
  const server = startProcess({
    args: [resolve(REPO_ROOT, 'api', 'src', 'index.ts')],
    command: resolve(BIN, 'tsx'),
    cwd: resolve(REPO_ROOT, 'api'),
    env: {
      DATABASE_URL: database,
      NESSIE_API_PORT: String(API_PORT),
      NESSIE_AUTH_SECRET: process.env.NESSIE_AUTH_SECRET ?? 'navigation-e2e-secret-navigation-e2e',
      NESSIE_DB_URL: database,
      NESSIE_MODE: 'local',
      NESSIE_MODEL_API_KEY: 'navigation-e2e',
      // Deliberately unreachable: no case in this suite runs inference, and
      // the one best-effort model call at bootstrap must fail fast, not hang.
      NESSIE_MODEL_BASE_URL: 'http://127.0.0.1:1/v1',
      NESSIE_MODEL_PROVIDER: 'openai',
      NESSIE_STORAGE_BACKEND: 'filesystem',
    },
    label: 'api',
  })
  try {
    await waitForUrl(`${API_URL}/api/health`, { label: 'API', timeoutMs: 180_000 })
  } catch (error) {
    await stopProcess(server)
    throw new Error(`${error.message}\n--- api output ---\n${server.output().slice(-4000)}`)
  }
  return server
}

export const startAdmin = async () => {
  if (await alreadyRunning(ADMIN_URL)) {
    console.log(`navigation e2e: using the admin already listening on ${ADMIN_URL}`)
    return adopted('admin')
  }
  const mode = adminMode()
  if (mode === 'preview' && !existsSync(resolve(ADMIN_ROOT, 'dist', 'index.html'))) {
    throw new Error('NAV_E2E_ADMIN_MODE=preview needs admin/dist — run pnpm --filter @nessie/admin build')
  }
  const server = startProcess({
    args: [mode === 'preview' ? 'preview' : '', '--port', String(ADMIN_PORT), '--strictPort'].filter(Boolean),
    command: resolve(BIN, 'vite'),
    cwd: ADMIN_ROOT,
    env: { NESSIE_API_PORT: String(API_PORT) },
    label: 'admin',
  })
  try {
    await waitForUrl(ADMIN_URL, { label: 'Admin', timeoutMs: 180_000 })
  } catch (error) {
    await stopProcess(server)
    throw new Error(`${error.message}\n--- admin output ---\n${server.output().slice(-4000)}`)
  }
  return server
}

// The API prints the one-time owner bootstrap URL on a fresh database. It is
// absent once any user exists, and the caller falls back to dev-login then.
export const readBootstrapToken = (server) => {
  const match = /\/bootstrap\?token=([0-9a-f-]{36})/.exec(server.output())
  return match?.[1] ?? null
}
