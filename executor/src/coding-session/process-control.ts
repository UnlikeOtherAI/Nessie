import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { packagedNativeHelperPath } from '../state-security.js'
import type { CodingProcessIdentity } from './types.js'

/**
 * How a session host starts, recognises and kills a coding agent's process
 * tree, behind one interface so each OS's containment is its own.
 *
 * POSIX puts the agent in its own process group and sweeps descendants from a
 * process table read before signalling, which also catches a grandchild that
 * called `setsid`; on Linux the host itself runs in a `systemd-run --user`
 * unit when a user manager is reachable (see `host-spawn.ts`), whose cgroup
 * catches whatever escapes both. On Windows a packaged runtime starts the
 * agent through the native helper's `job-run`, which holds it in a Job Object
 * with kill-on-close: the helper's pid is the recorded identity, and killing
 * the helper — or the host dying, which the helper watches — kills everything
 * in the job, including a grandchild whose parent already exited. A
 * development run has no verified helper, and falls back to killing the tree
 * it can see by `taskkill /F`, pid by pid, which misses exactly that
 * grandchild. A packaged runtime whose helper is missing starts no agent.
 *
 * Every signal checks an identity (pid plus process start time) first, so a
 * pid the OS has since handed to somebody else is never signalled. That holds
 * for the tree too: descendants are read only below a root that is still the
 * recorded process, each one carries its own start time, and each is checked
 * again right before its own signal. An identity without a start time is
 * unknown and is never killed.
 */
export type CodingProcessControl = {
  /** Set when this host cannot contain an agent; starting one fails with this reason. */
  refusal?: string
  spawnAgent: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess
  identify: (pid: number) => Promise<CodingProcessIdentity | undefined>
  /**
   * Every live descendant of the recorded process, read before anything is
   * signalled; none unless it is still that process.
   */
  descendants: (identity: CodingProcessIdentity) => Promise<CodingProcessIdentity[]>
  /** Kills the process and its tree while it is still the one recorded, and each snapshot member still its own. */
  killTree: (identity: CodingProcessIdentity, snapshot?: readonly CodingProcessIdentity[]) => Promise<void>
}

const TOOL_TIMEOUT_MS = 10_000
/** Between SIGTERM and SIGKILL on POSIX: a `git` killed outright leaves `index.lock` behind. */
const TERM_GRACE_MS = 2_000

type ProcessRow = { ppid: number; pgid?: number; started?: string }
type ProcessTable = Map<number, ProcessRow>

const run = (file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> => new Promise((settle) => {
  execFile(file, args, {
    timeout: TOOL_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...(env ? { env } : {}),
  }, (error, stdout) => {
    settle(error && !stdout ? '' : String(stdout))
  })
})

const delay = (ms: number): Promise<void> => new Promise((settle) => { setTimeout(settle, ms) })

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * The start time of a process that is still alive, read again when the read
 * fails: PowerShell and `ps` can time out under load, and a start time that
 * could not be read leaves nothing a later kill could check against.
 */
const startTimeOfLive = async (
  pid: number, read: (pid: number) => Promise<string | undefined>,
): Promise<string | undefined> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const value = await read(pid)
    if (value !== undefined || !alive(pid)) return value
  }
  return undefined
}

const recorded = (identity: CodingProcessIdentity): identity is Required<CodingProcessIdentity> => (
  typeof identity.startedAt === 'string' && /^\d+$/u.test(identity.startedAt)
)

/** Whether `table` shows exactly the recorded process: same pid, same start time. */
const isStill = (table: ProcessTable, identity: CodingProcessIdentity): boolean => (
  recorded(identity) && table.get(identity.pid)?.started === identity.startedAt
)

/** Every start time here is a decimal count (FILETIME, clock ticks or epoch seconds), so order is numeric. */
const notEarlier = (started: string | undefined, than: string): started is string => (
  started !== undefined && /^\d+$/u.test(started) && BigInt(started) >= BigInt(than)
)

/**
 * The recorded process's descendants in `table`, and on POSIX the rest of its
 * process group, each started no earlier than its parent — a "child" created
 * before its parent is a reused pid, not a child. Nothing at all unless the
 * root is still the recorded process: the children of whoever inherited its
 * pid are nobody this host started.
 */
const treeOf = (identity: CodingProcessIdentity, table: ProcessTable, withGroup: boolean): CodingProcessIdentity[] => {
  if (!isStill(table, identity) || !recorded(identity)) return []
  const byParent = new Map<number, number[]>()
  for (const [pid, row] of table) byParent.set(row.ppid, [...byParent.get(row.ppid) ?? [], pid])
  const found = new Map<number, string>()
  const queue = [{ pid: identity.pid, started: identity.startedAt }]
  while (queue.length > 0 && found.size < 4_096) {
    const parent = queue.shift()!
    for (const pid of byParent.get(parent.pid) ?? []) {
      const started = table.get(pid)?.started
      if (pid === identity.pid || found.has(pid) || !notEarlier(started, parent.started)) continue
      found.set(pid, started)
      queue.push({ pid, started })
    }
  }
  if (withGroup) {
    for (const [pid, row] of table) {
      if (row.pgid !== identity.pid || pid === identity.pid || found.has(pid)) continue
      if (notEarlier(row.started, identity.startedAt)) found.set(pid, row.started)
    }
  }
  return [...found].map(([pid, startedAt]) => ({ pid, startedAt }))
}

/** The members to signal: the snapshot's and a fresh walk's, each by its own start time. */
const membersOf = (
  identity: CodingProcessIdentity, snapshot: readonly CodingProcessIdentity[], fresh: readonly CodingProcessIdentity[],
): Map<number, string> => {
  const members = new Map<number, string>()
  for (const entry of [...snapshot, ...fresh]) {
    if (recorded(entry) && entry.pid !== identity.pid) members.set(entry.pid, entry.startedAt)
  }
  return members
}

const stillThere = (members: Map<number, string>, table: ProcessTable): number[] => (
  [...members].filter(([pid, started]) => table.get(pid)?.started === started).map(([pid]) => pid)
)

const system32 = (file: string): string => join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', file)

const powershell = (script: string): Promise<string> => run(
  system32(join('WindowsPowerShell', 'v1.0', 'powershell.exe')),
  ['-NoProfile', '-NonInteractive', '-Command', script],
)

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

/**
 * Windows start times are `Process.StartTime` as a UTC FILETIME, from one
 * source for a single process and for the whole table alike, so the two
 * always compare equal for the same process.
 */
const WINDOWS_TABLE = [
  '$s = @{}; foreach ($p in Get-Process) { try { $s[$p.Id] = $p.StartTime.ToFileTimeUtc() } catch {} }',
  'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object {',
  '"$($_.ProcessId) $($_.ParentProcessId) $($s[[int]$_.ProcessId])" }',
].join(' ')

const windowsControl = (jobHelper: string | undefined, refusal: string | undefined): CodingProcessControl => {
  const startedAt = async (pid: number): Promise<string | undefined> => {
    const answer = (await powershell(
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToFileTimeUtc() }`,
    )).trim()
    return /^\d+$/u.test(answer) ? answer : undefined
  }
  const table = async (): Promise<ProcessTable> => {
    const rows: ProcessTable = new Map()
    for (const line of (await powershell(WINDOWS_TABLE)).split(/\r?\n/u)) {
      const [pidText, ppidText, startedText] = line.trim().split(/\s+/u)
      if (!pidText || !ppidText || !/^\d+$/u.test(pidText)) continue
      rows.set(Number(pidText), {
        ppid: Number(ppidText), ...(startedText && /^\d+$/u.test(startedText) ? { started: startedText } : {}),
      })
    }
    return rows
  }
  // Never `/T`: that walks parent ids as they are now, which a reused pid makes somebody else's.
  const taskkill = (pid: number): Promise<string> => run(system32('taskkill.exe'), ['/PID', String(pid), '/F'])
  return {
    ...(refusal ? { refusal } : {}),
    // Through the helper the program is resolved and started by `CreateProcessW`
    // inside the job; the host still holds the same three pipes.
    spawnAgent: (command, args, options) => spawn(
      jobHelper ?? command,
      jobHelper ? ['job-run', '--', command, ...args] : args,
      { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false },
    ),
    identify: async (pid) => {
      const started = await startTimeOfLive(pid, startedAt)
      return started === undefined ? undefined : { pid, startedAt: started }
    },
    descendants: async (identity) => treeOf(identity, await table(), false),
    killTree: async (identity, snapshot = []) => {
      const before = await table()
      const members = membersOf(identity, snapshot, treeOf(identity, before, false))
      if (isStill(before, identity)) await taskkill(identity.pid)
      if (members.size === 0) return
      // Killing the root (through the helper, the whole job) takes a moment, so each
      // member is looked at again right before its own signal.
      for (const pid of stillThere(members, await table())) await taskkill(pid)
    },
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * `ps -o lstart=` in the C locale and UTC (`Tue Sep 23 10:00:00 2026`) as
 * epoch seconds, so neither a time-zone change nor a locale can make the same
 * process read as another.
 */
export const parsePsStartTime = (text: string): string | undefined => {
  const match = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/u.exec(text.trim())
  const month = match ? MONTHS.indexOf(match[1]!) : -1
  if (!match || month < 0) return undefined
  const [day, hours, minutes, seconds, year] = match.slice(2).map(Number) as [number, number, number, number, number]
  return String(Date.UTC(year, month, day, hours, minutes, seconds) / 1_000)
}

const PS_ENVIRONMENT = { LC_ALL: 'C', TZ: 'UTC', PATH: '/usr/bin:/bin' }

/** `/proc/<pid>/stat` after the parenthesised command name: state, ppid, pgrp, … field 22 is starttime. */
const procStat = (text: string): { ppid: number; pgid: number; started?: string } | undefined => {
  const fields = text.slice(text.lastIndexOf(')') + 2).split(' ')
  if (!fields[1] || !fields[2]) return undefined
  return { ppid: Number(fields[1]), pgid: Number(fields[2]), ...(/^\d+$/u.test(fields[19] ?? '') ? { started: fields[19] } : {}) }
}

const posixControl = (platform: NodeJS.Platform): CodingProcessControl => {
  const startedAt = async (pid: number): Promise<string | undefined> => {
    if (platform === 'linux') return procStat(await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => ''))?.started
    return parsePsStartTime(await run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], PS_ENVIRONMENT))
  }
  const table = async (): Promise<ProcessTable> => {
    const rows: ProcessTable = new Map()
    if (platform === 'linux') {
      const names = (await readdir('/proc').catch(() => [] as string[])).filter((name) => /^\d+$/u.test(name))
      await Promise.all(names.map(async (name) => {
        const stat = procStat(await readFile(`/proc/${name}/stat`, 'utf8').catch(() => ''))
        if (stat) rows.set(Number(name), stat)
      }))
      return rows
    }
    for (const line of (await run('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid=,lstart='], PS_ENVIRONMENT)).split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u.exec(line)
      if (!match) continue
      const started = parsePsStartTime(match[4]!)
      rows.set(Number(match[1]), { ppid: Number(match[2]), pgid: Number(match[3]), ...(started ? { started } : {}) })
    }
    return rows
  }
  const send = (pid: number, signal: NodeJS.Signals): void => {
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
      const started = await startTimeOfLive(pid, startedAt)
      return started === undefined ? undefined : { pid, startedAt: started }
    },
    descendants: async (identity) => treeOf(identity, await table(), true),
    killTree: async (identity, snapshot = []) => {
      const before = await table()
      const rootWasOurs = isStill(before, identity)
      const members = membersOf(identity, snapshot, treeOf(identity, before, true))
      /** Signals what is still ours; `false` once nothing is. */
      const signal = (current: ProcessTable, name: NodeJS.Signals): boolean => {
        const rootIsOurs = rootWasOurs && isStill(current, identity)
        // A pid that names a live process group is never handed out again, so
        // once the leader is gone its group is still only ever ours.
        if (rootWasOurs && (rootIsOurs || !current.has(identity.pid))) send(-identity.pid, name)
        if (rootIsOurs) send(identity.pid, name)
        const pending = stillThere(members, current)
        for (const pid of pending) send(pid, name)
        return rootIsOurs || pending.length > 0
      }
      if (!signal(before, 'SIGTERM')) return
      const deadline = Date.now() + TERM_GRACE_MS
      let current = before
      do {
        await delay(100)
        current = await table()
      } while (Date.now() < deadline && (isStill(current, identity) || stillThere(members, current).length > 0))
      signal(current, 'SIGKILL')
    },
  }
}

/**
 * The control for this host. A packaged Windows runtime without its native
 * helper refuses to start agents at all: without the Job Object nothing
 * contains a grandchild that outlives its parent, and the development
 * fallback is only for development.
 */
export const createCodingProcessControl = (
  platform: NodeJS.Platform = process.platform,
  options: { jobHelper?: string; packaged?: boolean } = {
    jobHelper: platform === 'win32' ? packagedJobHelper() : undefined,
    packaged: process.env.NESSIE_EXECUTOR_PACKAGED_CLI === '1',
  },
): CodingProcessControl => (
  platform === 'win32'
    ? windowsControl(options.jobHelper, options.packaged && !options.jobHelper ? 'containment_failed' : undefined)
    : posixControl(platform)
)

export const codingProcessIsAlive = alive
