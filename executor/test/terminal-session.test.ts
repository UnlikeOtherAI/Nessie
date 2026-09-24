import assert from 'node:assert/strict'
import test from 'node:test'

import { terminalProcessArguments } from '../src/coding-session/terminal-process.js'
import { createCodingHarness, OWNER_B, waitUntil } from './coding-session-harness.js'

test('the PTY launcher passes configured arguments literally after tmux end-of-options', () => {
  const args = terminalProcessArguments(['/bin/echo', "a'; touch /tmp/nope; '"])
  assert.deepEqual(args.slice(args.indexOf('--') + 1), ['/bin/echo', "a'; touch /tmp/nope; '"])
})

test('two real PTYs stay isolated, survive a bridge restart, render ANSI and close independently', {
  timeout: 120_000,
}, async () => {
  const harness = await createCodingHarness({
    codingSessions: { agents: { terminal: {
      command: process.platform === 'win32' ? ['C:\\Windows\\System32\\cmd.exe'] : ['/bin/sh'],
    } } },
    agentEnv: { inheritUserSession: false, set: { PATH: process.env.PATH ?? '/usr/bin:/bin' } },
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
    await harness.waitForStatus(first, (body) => body.status === 'working')
    await harness.waitForStatus(second, (body) => body.status === 'working')
    const write = async (sessionId: string, message: string) => {
      const answer = await harness.call('session_send', { sessionId, message, terminal: true })
      assert.equal(answer.ok, true, JSON.stringify(answer.body))
    }
    await write(first, process.platform === 'win32' ? 'echo FIRST_SESSION_ONLY\r' : "printf '\\033[2J\\033[HFIRST_SESSION_ONLY\\n'\r")
    await write(second, process.platform === 'win32' ? 'echo SECOND_SESSION_ONLY\r' : "printf '\\033[2J\\033[HSECOND_SESSION_ONLY\\n'\r")
    const readContaining = (sessionId: string, marker: string) => waitUntil(async () => {
      const answer = await harness.call('terminal_read', { sessionId })
      return typeof answer.body.text === 'string' && answer.body.text.includes(marker) ? answer.body.text : undefined
    }, 30_000, marker)
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
  } finally { await harness.cleanup() }
})
