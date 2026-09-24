import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { terminalProcessArguments } from '../src/coding-session/terminal-process.js'
import { createCodingHarness, OWNER_B, waitUntil } from './coding-session-harness.js'

test('the PTY launcher passes configured arguments literally after tmux end-of-options', () => {
  const args = terminalProcessArguments(['/bin/echo', "a'; touch /tmp/nope; '"])
  assert.deepEqual(args.slice(args.indexOf('--') + 1), ['/usr/bin/env', '--', '/bin/echo', "a'; touch /tmp/nope; '"])
})

test('two real PTYs stay isolated, survive a bridge restart, render ANSI and close independently', {
  timeout: 120_000,
}, async () => {
  const programDir = process.platform === 'win32' ? undefined : await mkdtemp(join(tmpdir(), 'nessie-terminal-argv-'))
  const program = programDir ? join(programDir, 'shell with spaces') : 'C:\\Windows\\System32\\cmd.exe'
  if (programDir) await symlink('/bin/sh', program)
  const harness = await createCodingHarness({
    codingSessions: { agents: { terminal: {
      command: [program],
    } } },
    agentEnv: { inheritUserSession: false, set: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      ...(process.env.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH } : {}),
    } },
  })
  try {
    const start = async (title: string) => {
      const answer = await harness.call('session_start', { agent: 'terminal', root: 'work', prompt: '', title })
      assert.equal(answer.ok, true, JSON.stringify(answer.body))
      return String(answer.body.sessionId)
    }
    const first = await start('First terminal')
    const second = await start('Second terminal')
    assert.notEqual(first, second)
    const running = async (sessionId: string) => {
      try { await harness.waitForStatus(sessionId, (body) => body.status === 'working') }
      catch (error) {
        const files = ['session.json', 'host.log', 'agent-stderr.log']
        for (const file of files) console.error(file, await readFile(join(harness.stateDir, 'sessions', sessionId, file), 'utf8').catch(() => 'unavailable'))
        throw error
      }
    }
    await running(first)
    await running(second)
    // A PTY exists before its shell finishes terminal initialization, which may flush input.
    for (const sessionId of [first, second]) await waitUntil(async () => {
      const captured = await readFile(join(harness.stateDir, 'sessions', sessionId, 'terminal.json'), 'utf8').catch(() => '')
      if (!captured) return undefined
      const answer = await harness.call('terminal_read', { sessionId })
      return typeof answer.body.text === 'string' && answer.body.text.trim().length > 0 ? true : undefined
    }, 30_000, 'initial shell screen')
    const write = async (sessionId: string, message: string) => {
      const answer = await harness.call('session_send', { sessionId, message, terminal: true })
      assert.equal(answer.ok, true, JSON.stringify(answer.body))
    }
    await write(first, process.platform === 'win32' ? 'echo FIRST_SESSION_ONLY\r' : "printf '\\033[2J\\033[HFIRST_SESSION_ONLY\\n'\r")
    await write(second, process.platform === 'win32' ? 'echo SECOND_SESSION_ONLY\r' : "printf '\\033[2J\\033[HSECOND_SESSION_ONLY\\n'\r")
    const readContaining = async (sessionId: string, marker: string) => {
      let last: unknown
      try {
        return await waitUntil(async () => {
          const answer = await harness.call('terminal_read', { sessionId })
          last = answer.body
          return typeof answer.body.text === 'string' && answer.body.text.includes(marker) ? answer.body.text : undefined
        }, 30_000, marker)
      } catch (error) {
        console.error('Last test-shell screen', last)
        for (const file of ['session.json', 'host.log', 'agent-stderr.log', 'terminal.json']) {
          console.error(file, await readFile(join(harness.stateDir, 'sessions', sessionId, file), 'utf8').catch(() => 'unavailable'))
        }
        throw error
      }
    }
    assert.doesNotMatch(await readContaining(first, 'FIRST_SESSION_ONLY'), /SECOND_SESSION_ONLY/)
    assert.doesNotMatch(await readContaining(second, 'SECOND_SESSION_ONLY'), /FIRST_SESSION_ONLY/)
    assert.equal((await harness.call('terminal_read', { sessionId: first }, { owner: OWNER_B })).ok, false)
    await harness.restartBridge()
    await write(first, 'echo AFTER_RECONNECT\r')
    await readContaining(first, 'AFTER_RECONNECT')
    assert.equal((await harness.call('session_close', { sessionId: first })).ok, true)
    await harness.waitForStatus(first, (body) => body.status === 'closed')
    await write(second, 'echo STILL_ALIVE\r')
    await readContaining(second, 'STILL_ALIVE')
  } finally {
    await harness.cleanup()
    if (programDir) await rm(programDir, { recursive: true, force: true })
  }
})
