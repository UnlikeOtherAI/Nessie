import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const adminRoot = resolve(here, '..', '..')
const repoRoot = resolve(adminRoot, '..')
const vite = resolve(repoRoot, 'node_modules', '.bin', 'vite')
export const adminUrl = 'http://127.0.0.1:5455'

const ready = async (timeout = 60_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const response = await fetch(adminUrl, { signal: AbortSignal.timeout(1_000) })
      // The E2E suite needs Vite's real development server, rather than a
      // static preview or an unrelated process which happens to own 5455.
      // This also verifies the project's required HMR client is actually
      // present before the browser starts exercising the production shell.
      if (response.ok && (await response.text()).includes('@vite/client')) return true
    } catch { /* polling a local process */ }
    await new Promise((done) => setTimeout(done, 200))
  }
  return false
}

export const startAdmin = async () => {
  if (await ready(1_000)) return { adopted: true, stop: async () => {} }
  if (!existsSync(vite)) throw new Error('Vite is missing — run pnpm install first.')
  const child = spawn(vite, ['--port', '5455', '--strictPort'], {
    cwd: adminRoot, detached: true, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = []
  child.stdout.on('data', (chunk) => output.push(String(chunk)))
  child.stderr.on('data', (chunk) => output.push(String(chunk)))
  if (!await ready()) {
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* process already exited */ }
    throw new Error(`Vite did not start on 5455:\n${output.join('').slice(-3_000)}`)
  }
  return {
    adopted: false,
    stop: async () => {
      if (child.exitCode !== null) return
      try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
    },
  }
}
