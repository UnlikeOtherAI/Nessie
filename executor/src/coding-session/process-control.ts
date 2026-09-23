import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { packagedNativeHelperPath } from '../state-security.js'
import type { CodingProcessIdentity } from './types.js'

/**
 * How a session host starts, recognises and kills a coding agent's process
 * tree, behind one interface so each OS's containment is its own.
 *
 * POSIX puts the agent in its own process group and sweeps descendants from a
 * `ps` snapshot taken before signalling, which also catches a grandchild that
 * called `setsid`; on Linux the host itself runs in a `systemd-run --user`
 * unit when a user manager is reachable (see `host-spawn.ts`), whose cgroup
 * catches whatever escapes both. On Windows a packaged runtime starts the
 * agent through the native helper's `job-run`, which holds it in a Job Object
 * with kill-on-close: the helper's pid is the recorded identity, and killing
 * the helper — or the host dying, which the helper watches — kills everything
 * in the job, including a grandchild whose parent already exited. A
 * development run has no verified helper, and falls back to `taskkill /T /F`
 * by its absolute System32 path, which misses exactly that grandchild.
 *
 * Every kill checks the recorded identity (pid plus process start time) first,
 * so a pid the OS has since handed to somebody else is never signalled.
 */
export type CodingProcessControl = {
  spawnAgent: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess
  identify: (pid: number) => Promise<CodingProcessIdentity | undefined>
  /** Every live descendant of `pid`, read before anything is signalled. */
  descendants: (pid: number) => Promise<number[]>
  /** Kills the process (when it is still the one recorded) and every descendant named. */
  killTree: (identity: CodingProcessIdentity, snapshot?: readonly number[]) => Promise<void>
}

const TOOL_TIMEOUT_MS = 10_000

const run = (file: string, args: string[]): Promise<string> => new Promise((settle) => {
  execFile(file, args, { timeout: TOOL_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
    settle(error && !stdout ? '' : String(stdout))
  })
})

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const system32 = (file: string): string => join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', file)

const powershell = (script: string): Promise<string> => run(
  system32(join('WindowsPowerShell', 'v1.0', 'powershell.exe')),
  ['-NoProfile', '-NonInteractive', '-Command', script],
)

/** Walks a pid/ppid table from `root`; a child created before its parent is a reused pid, not a child. */
const walk = (root: number, rows: { pid: number; ppid: number; started?: number }[]): number[] => {
  const byParent = new Map<number, typeof rows>()
  for (const row of rows) byParent.set(row.ppid, [...byParent.get(row.ppid) ?? [], row])
  const found: number[] = []
  const rootStarted = rows.find((row) => row.pid === root)?.started
  const queue: { pid: number; started?: number }[] = [{ pid: root, started: rootStarted }]
  while (queue.length > 0 && found.length < 4_096) {
    const parent = queue.shift()!
    for (const child of byParent.get(parent.pid) ?? []) {
      if (child.pid === root || found.includes(child.pid)) continue
      if (parent.started !== undefined && child.started !== undefined && child.started < parent.started) continue
      found.push(child.pid)
      queue.push(child)
    }
  }
  return found
}

/**
 * The native helper beside the packaged Node runtime, when this process is the
 * installed package — the same helper, found the same way, that secures the
 * executor's state. A development run has none and gets `undefined`.
 */
export const packagedJobHelper = (environment: NodeJS.ProcessEnv = process.env): string | undefined => {
  if (environment.NESSIE_EXECUTOR_PACKAGED_CLI !== '1') return undefined
  const path = packagedNativeHelperPath()
  try {
    const entry = lstatSync(path)
    return entry.isFile() && !entry.isSymbolicLink() ? path : undefined
  } catch {
    return undefined
  }
}

const windowsControl = (jobHelper: string | undefined): CodingProcessControl => {
  const startedAt = async (pid: number): Promise<string | undefined> => {
    const answer = (await powershell(
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToFileTimeUtc() }`,
    )).trim()
    return /^\d+$/u.test(answer) ? answer : undefined
  }
  const taskkill = (pid: number): Promise<string> => run(system32('taskkill.exe'), ['/PID', String(pid), '/T', '/F'])
  return {
    // Through the helper the program is resolved and started by `CreateProcessW`
    // inside the job; the host still holds the same three pipes.
    spawnAgent: (command, args, options) => spawn(
      jobHelper ?? command,
      jobHelper ? ['job-run', '--', command, ...args] : args,
      { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false },
    ),
    identify: async (pid) => {
      const started = await startedAt(pid)
      return started === undefined ? undefined : { pid, startedAt: started }
    },
    descendants: async (pid) => {
      const table = await powershell(
        'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | '
        + 'ForEach-Object { $c = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }; '
        + '"$($_.ProcessId) $($_.ParentProcessId) $c" }',
      )
      const rows = table.split(/\r?\n/u).flatMap((line) => {
        const [pidText, ppidText, startedText] = line.trim().split(/\s+/u)
        if (!pidText || !ppidText) return []
        return [{ pid: Number(pidText), ppid: Number(ppidText), started: Number(startedText) || undefined }]
      })
      return walk(pid, rows)
    },
    killTree: async (identity, snapshot = []) => {
      const current = await startedAt(identity.pid)
      if (current !== undefined && (identity.startedAt === undefined || current === identity.startedAt)) {
        await taskkill(identity.pid)
      }
      for (const pid of snapshot) if (alive(pid)) await taskkill(pid)
    },
  }
}

const posixControl = (platform: NodeJS.Platform): CodingProcessControl => {
  const startedAt = async (pid: number): Promise<string | undefined> => {
    if (platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '')
      // Field 22 (starttime) counts from the end of the parenthesised command name.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      return fields[19] && /^\d+$/u.test(fields[19]) ? fields[19] : undefined
    }
    const answer = (await run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)])).trim()
    return answer || undefined
  }
  const kill = (pid: number, signal: NodeJS.Signals): void => {
    try {
      process.kill(pid, signal)
    } catch {
      // Already gone.
    }
  }
  return {
    // Its own process group, so the group can be killed without the host.
    spawnAgent: (command, args, options) => spawn(command, args, {
      cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false, detached: true,
    }),
    identify: async (pid) => {
      const started = await startedAt(pid)
      return started === undefined ? undefined : { pid, startedAt: started }
    },
    descendants: async (pid) => {
      const table = await run('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid='])
      const rows = table.split('\n').flatMap((line) => {
        const [pidText, ppidText, pgidText] = line.trim().split(/\s+/u)
        return pidText && ppidText ? [{ pid: Number(pidText), ppid: Number(ppidText), pgid: Number(pgidText) }] : []
      })
      const group = rows.filter((row) => row.pgid === pid && row.pid !== pid).map((row) => row.pid)
      return [...new Set([...walk(pid, rows), ...group])]
    },
    killTree: async (identity, snapshot = []) => {
      const current = await startedAt(identity.pid)
      if (current !== undefined && (identity.startedAt === undefined || current === identity.startedAt)) {
        kill(-identity.pid, 'SIGKILL')
        kill(identity.pid, 'SIGKILL')
      }
      for (const pid of snapshot) kill(pid, 'SIGKILL')
    },
  }
}

export const createCodingProcessControl = (
  platform: NodeJS.Platform = process.platform,
  options: { jobHelper?: string } = { jobHelper: platform === 'win32' ? packagedJobHelper() : undefined },
): CodingProcessControl => (
  platform === 'win32' ? windowsControl(options.jobHelper) : posixControl(platform)
)

export const codingProcessIsAlive = alive
