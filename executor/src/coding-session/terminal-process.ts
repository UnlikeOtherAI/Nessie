import { execFile, spawn } from 'node:child_process'
import { mkdtemp, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'

import {
  EXECUTOR_TERMINAL_COLS as COLS,
  EXECUTOR_TERMINAL_ROWS as ROWS,
  EXECUTOR_TERMINAL_SCROLLBACK as HISTORY,
  type ExecutorSessionScreen,
} from '@nessie/schemas'

import { resolveProgramPath } from './program-path.js'

const run = promisify(execFile)
const delay = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) })

/** env keeps even a lone executable in tmux's direct-argv mode, never `sh -c`. */
export const terminalProcessArguments = (argv: readonly string[]): string[] => [
  'new-session', '-d', '-s', 'nessie', '-x', String(COLS), '-y', String(ROWS), '--', '/usr/bin/env', '--', ...argv,
]

/**
 * A dedicated foreground tmux server under the existing containment guard.
 * Its socket is owner-only and separate from the person's own tmux server.
 * Local attachment: tmux -S <socket> attach -t nessie.
 */
export const runTerminalProcess = async (): Promise<void> => {
  // The marker belongs to this executor helper, never the user's program.
  delete process.env.NESSIE_EXECUTOR_PACKAGED_CLI
  if (process.platform === 'win32') {
    const { runWindowsTerminal } = await import('./terminal-windows.js')
    return runWindowsTerminal()
  }
  const lines = createInterface({ input: process.stdin })
  const iterator = lines[Symbol.asyncIterator]()
  const first = await iterator.next()
  const argv: unknown = first.done ? undefined : JSON.parse(first.value)
  if (!Array.isArray(argv) || !argv.length || argv.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new Error('terminal_invalid_program')
  }
  const tmux = await resolveProgramPath('tmux', process.env)
  if (!tmux) throw new Error('terminal_tmux_missing')
  const socketDir = await mkdtemp(join(tmpdir(), 'nessie-tmux-'))
  const socket = join(socketDir, 's')
  const env = { ...process.env, TERM: 'xterm-256color', TMUX: '' }
  const server = spawn(tmux, ['-D', '-S', socket, '-f', '/dev/null'], { env, stdio: 'ignore' })
  let serverEnded = false
  server.once('exit', () => { serverEnded = true })
  server.once('error', () => { serverEnded = true })
  // A client must never auto-start a competing server while our foreground server binds.
  const command = (...args: string[]) => run(tmux, ['-N', '-S', socket, ...args], {
    env, timeout: 5_000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8',
  })
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await command('set-option', '-g', 'remain-on-exit', 'on', ';',
          'set-option', '-g', 'history-limit', String(HISTORY), ';', ...terminalProcessArguments(argv))
        break
      }
      catch {
        if (serverEnded || attempt >= 30) throw new Error('terminal_tmux_start_failed')
        await delay(100)
      }
    }
    await command('set-window-option', '-t', 'nessie:0', 'window-size', 'manual')
    await command('resize-window', '-t', 'nessie:0', '-x', String(COLS), '-y', String(ROWS))
    process.stdout.write(JSON.stringify({ socketPath: socket }) + '\n')
    let inputEnded = false
    void (async () => {
      for await (const line of { [Symbol.asyncIterator]: () => iterator }) {
        const data: unknown = JSON.parse(line)
        if (typeof data !== 'string' || data.length > 32_000) throw new Error('terminal_invalid_input')
        const bytes = Buffer.from(data, 'utf8')
        for (let offset = 0; offset < bytes.length; offset += 512) {
          await command('send-keys', '-t', 'nessie:0.0', '-H',
            ...[...bytes.subarray(offset, offset + 512)].map((byte) => byte.toString(16).padStart(2, '0')))
        }
      }
      inputEnded = true
    })().catch(() => { inputEnded = true })
    let previous = ''
    while (!inputEnded && !serverEnded) {
      const capture = await command('capture-pane', '-p', '-e', '-S', '-' + HISTORY, '-t', 'nessie:0.0', ';',
        'display-message', '-p', '-t', 'nessie:0.0', 'NESSIE:#{cursor_x}:#{cursor_y}:#{pane_dead}:#{pane_dead_status}')
      const parts = capture.stdout.trimEnd().split('\n')
      const cursor = parts.pop()?.split(':')
      if (!cursor || cursor[0] !== 'NESSIE') throw new Error('terminal_capture_failed')
      const x = Number(cursor[1])
      const y = Number(cursor[2])
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= COLS || y < 0 || y >= ROWS) {
        throw new Error('terminal_capture_failed')
      }
      while (parts.join('\n').length > 240_000 && parts.length > ROWS) parts.shift()
      const ansi = parts.join('\r\n') + '\u001b[' + (y + 1) + ';' + (x + 1) + 'H'
      if (ansi !== previous) {
        previous = ansi
        const screen: ExecutorSessionScreen = {
          ansi, capturedAt: new Date().toISOString(), cols: COLS, rows: ROWS, kind: 'terminal',
        }
        process.stdout.write(JSON.stringify(screen) + '\n')
      }
      if (cursor[3] === '1') { process.exitCode = Number(cursor[4]) || 0; break }
      await delay(200)
    }
  } finally {
    await command('kill-server').catch(() => undefined)
    if (!serverEnded) server.kill('SIGTERM')
    await rmdir(socketDir).catch(() => undefined)
    lines.close()
    process.stdin.destroy()
  }
}
