import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createCodingProcessControl } from '../src/coding-session/process-control.js'
import { alive, createCodingHarness, waitUntil, type CodingHarness } from './coding-session-harness.js'

/**
 * The coding-sessions bridge as the daemon drives it: a real bridge process
 * started through `createExecutorMcpSessionManager`, detached session hosts,
 * and the scripted coding agent speaking Claude Code's and Codex's protocols.
 * The bridge holds nothing in memory, so killing it between any two calls
 * must change nothing a caller can see.
 */

const started = async (harness: CodingHarness, args: Record<string, unknown>): Promise<string> => {
  const answer = await harness.call('session_start', { agent: 'claude', root: 'work', ...args })
  assert.equal(answer.ok, true, JSON.stringify(answer.body))
  return answer.body.sessionId as string
}

const lastResultText = (body: Record<string, unknown>): string => (body.lastResult as { text: string } | undefined)?.text ?? ''

test('a session survives bridge restarts, and its turn ends in a result', { timeout: 120_000 }, async () => {
  const harness = await createCodingHarness({ idleTimeoutMs: 200 })
  try {
    const sessionId = await started(harness, { prompt: '#sleep=1500 first task' })
    await harness.restartBridge()
    const working = await harness.waitForStatus(sessionId, (body) => body.status === 'working')
    assert.equal(working.turn, 1)
    await harness.restartBridge()
    const done = await harness.waitForStatus(sessionId, (body) => body.status === 'waiting_for_input')
    assert.match(lastResultText(done), /first task/)
    const listed = await harness.call('session_list', {})
    assert.deepEqual((listed.body.sessions as { sessionId: string }[]).map((entry) => entry.sessionId), [sessionId])
    assert.deepEqual(listed.body.agents, ['claude', 'codex'])
  } finally {
    await harness.cleanup()
  }
})

test('a follow-up written during a turn folds into that turn', { timeout: 120_000 }, async () => {
  const harness = await createCodingHarness()
  try {
    const sessionId = await started(harness, { prompt: '#sleep=3000 build the parser' })
    await harness.waitForStatus(sessionId, (body) => body.status === 'working')
    assert.equal((await harness.call('session_send', { sessionId, message: 'also add tests' })).ok, true)
    const done = await harness.waitForStatus(sessionId, (body) => body.status === 'waiting_for_input')
    assert.match(lastResultText(done), /build the parser \| also add tests/)
    assert.equal(done.turn, 1)
  } finally {
    await harness.cleanup()
  }
})

test('interrupt stops the turn and the session takes the next message', { timeout: 120_000 }, async () => {
  const harness = await createCodingHarness()
  try {
    const sessionId = await started(harness, { prompt: '#sleep=60000 a very long job' })
    await harness.waitForStatus(sessionId, (body) => body.status === 'working')
    assert.equal((await harness.call('session_interrupt', { sessionId })).body.interrupted, true)
    const stopped = await harness.waitForStatus(sessionId, (body) => body.status === 'interrupted')
    assert.equal((stopped.lastResult as { subtype: string }).subtype, 'error_during_execution')
    await harness.call('session_send', { sessionId, message: 'something short instead' })
    const done = await harness.waitForStatus(sessionId, (body) => body.status === 'waiting_for_input')
    assert.match(lastResultText(done), /something short instead/)
    assert.equal(done.turn, 2)
    assert.equal((await harness.agents()).filter((entry) => entry.event === 'start').length, 1)
  } finally {
    await harness.cleanup()
  }
})

test('close kills the agent and the grandchild that escaped its group', { timeout: 120_000 }, async () => {
  const harness = await createCodingHarness()
  try {
    const sessionId = await started(harness, { prompt: '#fork #sleep=60000 work on it' })
    const grandchild = await waitUntil(async () => {
      const name = (await readdir(harness.recordDir)).find((entry) => entry.startsWith('grandchild-'))
      return name ? Number(name.slice('grandchild-'.length, -'.pid'.length)) : undefined
    }, 30_000, 'the grandchild')
    const agent = (await harness.agents()).find((entry) => entry.event === 'start')!.pid as number
    assert.equal(alive(grandchild), true)
    assert.equal((await harness.call('session_close', { sessionId })).body.status, 'closing')
    await harness.waitForStatus(sessionId, (body) => body.status === 'closed')
    await waitUntil(async () => (!alive(agent) && !alive(grandchild) ? true : undefined), 15_000, 'the tree to die')
    const refused = await harness.call('session_send', { sessionId, message: 'more' })
    assert.equal(refused.code, 'coding_session_closed')
  } finally {
    await harness.cleanup()
  }
})

test('a host killed with -9 reads as host_lost, and the next send resumes without a second agent', {
  timeout: 150_000,
}, async () => {
  const harness = await createCodingHarness()
  try {
    const sessionId = await started(harness, { prompt: '#sleep=120000 a long refactor' })
    await harness.waitForStatus(sessionId, (body) => body.status === 'working')
    const lockPath = join(harness.stateDir, 'sessions', sessionId, 'host.lock')
    const host = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number }
    const firstAgent = (await harness.agents()).find((entry) => entry.event === 'start')!
    // Windows hands a dead pid to a new process within seconds, so "stopped" is judged by pid and start time.
    const control = createCodingProcessControl()
    const firstIdentity = await control.identify(firstAgent.pid as number)
    assert.ok(firstIdentity?.startedAt, 'the first agent is running')
    process.kill(host.pid, 'SIGKILL')
    const lost = await harness.waitForStatus(sessionId, (body) => body.status === 'interrupted')
    assert.equal(lost.reason, 'host_lost')
    assert.match(String(lost.pendingNotice), /host stopped/)
    await harness.call('session_send', { sessionId, message: 'carry on' })
    const done = await harness.waitForStatus(sessionId, (body) => body.status === 'waiting_for_input', undefined, 60_000)
    assert.match(lastResultText(done), /carry on/)
    const starts = (await harness.agents()).filter((entry) => entry.event === 'start')
    assert.equal(starts.length, 2)
    assert.equal(starts[1]!.resume, true)
    assert.equal(starts[1]!.sessionId, firstAgent.sessionId)
    const survivor = await control.identify(firstAgent.pid as number)
    const firstStillRunning = survivor?.startedAt === firstIdentity.startedAt
    assert.deepEqual([firstStillRunning, alive(starts[1]!.pid as number)], [false, true],
      'exactly one agent after the resume: the lost host\'s was stopped first')
  } finally {
    await harness.cleanup()
  }
})

test('codex runs a process per turn, resumes its thread, and reports its failure shape', { timeout: 120_000 }, async () => {
  const harness = await createCodingHarness()
  try {
    const sessionId = await started(harness, { agent: 'codex', prompt: 'first change' })
    const first = await harness.waitForStatus(sessionId, (body) => body.status === 'waiting_for_input')
    assert.match(lastResultText(first), /Codex done: first change/)
    await harness.call('session_send', { sessionId, message: 'second change' })
    const second = await harness.waitForStatus(sessionId, (body) => body.status === 'waiting_for_input' && body.turn === 2)
    assert.match(lastResultText(second), /Codex done: second change/)
    const starts = (await harness.agents()).filter((entry) => entry.agent === 'codex' && entry.event === 'start')
    assert.deepEqual(starts.map((entry) => entry.resume), [false, true])
    assert.equal(starts[1]!.threadId, starts[0]!.threadId)
    const failing = await started(harness, { agent: 'codex', prompt: '#codexfail anything' })
    const failed = await harness.waitForStatus(failing, (body) => body.status === 'waiting_for_input')
    const result = failed.lastResult as { isError: boolean; subtype: string; text: string }
    assert.equal(result.isError, true)
    assert.equal(result.subtype, 'error')
    assert.match(result.text, /usage limit/)
  } finally {
    await harness.cleanup()
  }
})

test('no host path and no account data reach any answer', { timeout: 120_000 }, async () => {
  const harness = await createCodingHarness()
  try {
    const sessionId = await started(harness, { prompt: '#path #deny #test #secret report back' })
    await harness.waitForStatus(sessionId, (body) => body.status === 'waiting_for_input')
    const events = await harness.call('session_status', { sessionId, detail: 'events', cursor: '0.0.0' })
    const kinds = (events.body.events as { kind: string }[]).map((event) => event.kind)
    assert.ok(kinds.includes('tool') && kinds.includes('result') && kinds.includes('user'))
    const review = await harness.call('session_review', { sessionId })
    assert.equal((review.body.lastTest as { exitCode: number }).exitCode, 3)
    assert.equal(review.body.branch, 'main')
    await harness.call('session_list', {})
    const all = harness.outputs.join('\n')
    assert.match(all, /<work>\/README\.md/)
    assert.match(all, /<host path>/)
    assert.match(all, /GH_TOKEN=<secret>/)
    const forbidden = [
      harness.root, harness.dir, homedir(), tmpdir(), 'person@example.com', 'Private Org', 'Private Docs',
      // A token the agent printed, and a value the configuration set, never leave the host.
      `ghp_${'Z9y8'.repeat(9)}`, 'from-config',
    ]
    for (const value of forbidden) {
      for (const spelling of new Set([value, value.replaceAll('\\', '/'), value.replaceAll('\\', '\\\\'), value.toLowerCase()])) {
        assert.equal(all.includes(spelling), false, `an answer carried ${spelling}`)
      }
    }
    const denials = events.body.permissionDenials as { tool: string; summary: string }[]
    assert.deepEqual(denials, [{ tool: 'Bash', summary: 'git push --force' }])
  } finally {
    await harness.cleanup()
  }
})
