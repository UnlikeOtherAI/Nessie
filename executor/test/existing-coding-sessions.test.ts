import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { ExistingCodex } from '../src/existing-session/codex.js'
import { ExistingSessions } from '../src/existing-session/manager.js'
import { existingSessionsEnabled } from '../src/existing-session/settings.js'
import { existingSessionId, type ExistingSession } from '../src/existing-session/types.js'

const NATIVE = '11111111-1111-4111-a111-111111111111'
const nativeRow = { id: NATIVE, name: 'Same title', cwd: '/same/repo', updatedAt: 1_790_000_000, source: 'vscode' }

test('Codex uses native queue without loading or resuming the original conversation', async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const codex = new ExistingCodex({ path: '/fake/codex', version: 'test' }, { CODEX_HOME: '/profile-a' }, {
    close: () => undefined,
    call: async (method, params) => {
      calls.push({ method, params })
      if (method === 'thread/list') return { data: [nativeRow] }
      if (method === 'thread/read') return { thread: { ...nativeRow, turns: [] } }
      return { data: [] }
    },
  })
  const [session] = await codex.list()
  assert.equal(session?.status, 'unknown', 'persisted metadata never proves an idle runtime')
  assert.equal(session?.capabilities.queue, true)
  await codex.read(session!, false)
  const result = await codex.queue(session!, 'Nessie instruction', NATIVE)
  assert.equal(result.state, 'queued_natively')
  assert.deepEqual(calls.map((call) => call.method), [
    'thread/list', 'thread/queue/list', 'thread/read', 'thread/queue/add',
  ])
  assert.equal(calls[0]!.params.useStateDbOnly, true, 'never scan unbounded rollout history for inventory')
  assert.equal(calls[2]!.params.includeTurns, false)
  assert.equal(calls[3]!.params.threadId, NATIVE)
  assert.equal(calls[3]!.params.clientUserMessageId, NATIVE)
  assert.match(String(result.behavior), /during its current turn/u)
})

test('same title and repository cannot alias native sessions or provider profiles', () => {
  assert.notEqual(existingSessionId('codex', '/a', NATIVE), existingSessionId('codex', '/b', NATIVE))
  assert.notEqual(existingSessionId('claude', '/a', NATIVE), existingSessionId('codex', '/a', NATIVE))
  assert.notEqual(existingSessionId('codex', '/a', randomUUID()), existingSessionId('codex', '/a', NATIVE))
  assert.equal(existingSessionId('codex', '/a', NATIVE), existingSessionId('codex', '/a', NATIVE))
})

test('a provider without native queue support remains inspectable and cannot advertise queue', async () => {
  const codex = new ExistingCodex({ path: '/fake/codex', version: 'older' }, {}, {
    close: () => undefined, call: async (method) => {
      if (method === 'thread/list') return { data: [nativeRow] }
      throw new Error('Unknown method')
    },
  })
  const [session] = await codex.list()
  assert.equal(session?.capabilities.queue, false)
  await assert.rejects(codex.queue(session!, 'do work', NATIVE), /unavailable/u)
})

test('default-on discovery, disable, idempotent dispatch and unknown outcomes preserve external sessions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-existing-'))
  let writes = 0
  let detached = 0
  const session: ExistingSession = { sessionId: existingSessionId('codex', '/a', NATIVE), nativeId: NATIVE,
    provider: 'codex', title: 'Same title', cwd: '/same/repo', client: 'unknown', status: 'unknown',
    updatedAt: new Date().toISOString(), capabilities: { queue: true, push: false, steer: false, interrupt: false,
      reason: 'Native experimental input' } }
  const manager = new ExistingSessions(directory, async () => ({ codex: {
    nextCursor: null, program: { path: '/fake/codex', version: 'test' }, list: async () => [session],
    read: async () => session, close: () => { detached += 1 }, queue: async () => {
      writes += 1
      throw new Error('Connection lost after provider accepted input')
    },
  } }))
  try {
    assert.equal(await existingSessionsEnabled(directory), true)
    assert.equal((await manager.list()).length, 1)
    const command = randomUUID()
    const first = await manager.send('queue', session.sessionId, 'Do this', 'owner-a-123456789', command)
    assert.equal(first.state, 'outcome_unknown')
    assert.deepEqual(await manager.send('queue', session.sessionId, 'Do this', 'owner-a-123456789', command), first)
    assert.equal(writes, 1, 'ambiguous writes are never blindly retried')
    await assert.rejects(manager.send('queue', session.sessionId, 'Different', 'owner-a-123456789', command), /already used/u)
    await assert.rejects(manager.send('steer', session.sessionId, 'Do this', 'owner-a-123456789', randomUUID()), /Native/u)
    await writeFile(join(directory, 'existing-coding-sessions.json'), JSON.stringify({ enabled: false }))
    assert.deepEqual(await manager.list(), [])
    await assert.rejects(manager.send('queue', session.sessionId, 'Do this', 'owner-a-123456789', randomUUID()), /disabled/u)
    assert.equal(writes, 1)
    assert.ok(detached > 0, 'disable detaches the metadata connection; no process-control API is available')
    await writeFile(join(directory, 'existing-coding-sessions.json'), '{malformed')
    assert.equal(await existingSessionsEnabled(directory), false)
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }) }
})
