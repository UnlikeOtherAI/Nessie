#!/usr/bin/env node

// Pre-dev port safety check: verifies that the port this instance will actually
// bind is free, and fails loudly with an actionable message when it is not. It
// NEVER kills anything — killing whatever holds a port destroyed parallel dev
// sessions binding a different one.
//
// Which port it checks:
//   --api (default)  the API port      → `NESSIE_API_PORT`
//   --admin          the admin port    → `NESSIE_ADMIN_PORT`
//   <number>         that exact port   (for another local service)
//
// The named forms resolve through `scripts/dev-ports.mjs`, so this guard and
// the servers themselves can never disagree about which port is meant.

import { execFileSync } from 'node:child_process'
import net from 'node:net'

import {
  ADMIN_PORT_ENV,
  API_PORT_ENV,
  parsePort,
  resolveAdminPort,
  resolveApiPort,
} from '../../scripts/dev-ports.mjs'

const resolveTarget = () => {
  const arg = process.argv[2]?.trim()
  if (arg && arg !== '--api' && arg !== '--admin') {
    return { envKey: null, label: 'port', port: parsePort(arg, 'the port argument') }
  }
  if (arg === '--admin') {
    return { envKey: ADMIN_PORT_ENV, label: 'admin', port: resolveAdminPort() }
  }
  return { envKey: API_PORT_ENV, label: 'API', port: resolveApiPort() }
}

const probePort = (port) =>
  new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once('error', (err) => resolve({ free: false, code: err.code }))
    server.once('listening', () => {
      server.close(() => resolve({ free: true }))
    })
    server.listen({ port, host: '0.0.0.0' })
  })

const run = (file, args) => {
  try {
    return execFileSync(file, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

// Windows has no lsof. `netstat -ano` names the listening pid, and `tasklist`
// turns that into something a person recognises — without which this guard
// reported "could not identify the holding process" on every Windows box and
// the person had to go and find the command themselves.
const describeHolderWindows = (port) => {
  const out = run('netstat', ['-ano'])
  const line = out
    .split('\n')
    .map((value) => value.trim())
    .find((value) => {
      const cols = value.split(/\s+/)
      return cols[0] === 'TCP'
        && cols[3] === 'LISTENING'
        && (cols[1]?.endsWith(`:${port}`) ?? false)
    })
  if (!line) return null
  const pid = line.split(/\s+/).pop()
  const task = run('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'])
  const command = task.split(',')[0]?.replace(/"/g, '') || 'unknown'
  return {
    command,
    detail: line,
    inspect: `netstat -ano | findstr :${port}`,
    kill: `taskkill /PID ${pid} /F`,
    pid,
  }
}

const describeHolderPosix = (port) => {
  const out = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'])
  const lines = out.split('\n')
  if (lines.length < 2) return null
  // lsof columns: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
  const cols = lines[1].split(/\s+/)
  return {
    command: cols[0],
    detail: out,
    inspect: `lsof -nP -iTCP:${port} -sTCP:LISTEN`,
    kill: `kill ${cols[1]}`,
    pid: cols[1],
  }
}

const describeHolder = (port) =>
  process.platform === 'win32' ? describeHolderWindows(port) : describeHolderPosix(port)

let target
try {
  target = resolveTarget()
} catch (error) {
  console.error(`predev: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const result = await probePort(target.port)
if (result.free) process.exit(0)

if (result.code && result.code !== 'EADDRINUSE') {
  console.error(
    `predev: could not probe ${target.label} port ${target.port} (${result.code});`
    + ' resolve this before starting the dev server.',
  )
  process.exit(1)
}

console.error(
  `predev: ${target.label} port ${target.port} is already in use;`
  + ' this instance cannot start.',
)
const holder = describeHolder(target.port)
if (holder) {
  console.error(`predev: held by pid ${holder.pid} (${holder.command}):`)
  console.error(holder.detail)
  console.error(`predev: if that process is safe to stop, run: ${holder.kill}`)
} else {
  console.error('predev: could not identify the holding process.')
  console.error(`predev: inspect it yourself with: ${describeInspectHint(target.port)}`)
}
if (target.envKey) {
  // The way out that does NOT disturb the holder: another worktree, verifying
  // its own change, takes its own pair rather than this one's.
  console.error(
    `predev: or give this worktree its own port by setting ${target.envKey}`
    + ' in the environment or the repo root .env.',
  )
}
process.exit(1)

function describeInspectHint(port) {
  return process.platform === 'win32'
    ? `netstat -ano | findstr :${port}`
    : `lsof -nP -iTCP:${port} -sTCP:LISTEN`
}
