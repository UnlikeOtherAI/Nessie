import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { encodeEventCursor, openEventLog, parseEventCursor, readEventPage } from '../src/coding-session/session-events.js'
import { codingSessionPaths, writeJsonAtomic, type CodingSessionPaths } from '../src/coding-session/session-files.js'
import { acquireHostLock, hostLockIsStale, readHostLock } from '../src/coding-session/session-lock.js'
import { claimCommand, listRequests, writeRequest } from '../src/coding-session/session-requests.js'
import { CODING_STATUS_MAX_BYTES, composeCodingStatus, deriveCodingStatus } from '../src/coding-session/status.js'
import { initialCodingSessionState, type CodingSessionMeta } from '../src/coding-session/types.js'

const SESSION = '0f0e0d0c-0b0a-4908-8706-050403020100'

const scratch = async (): Promise<{ dir: string; paths: CodingSessionPaths }> => {
  const dir = await mkdtemp(join(tmpdir(), 'nessie-coding-store-'))
  const paths = codingSessionPaths(dir, SESSION)
  await mkdir(paths.inbox, { recursive: true })
  return { dir, paths }
}

const meta: CodingSessionMeta = {
  version: 1, sessionId: SESSION, ownerKey: 'owner-a-0123456789', agent: 'claude', rootName: 'work', path: '.',
  title: 'Task', createdAt: '2026-09-22T00:00:00.000Z',
}

test('a session id is only ever one we minted', () => {
  assert.throws(() => codingSessionPaths('/state', '../../etc'), /lowercase UUID/u)
  assert.throws(() => codingSessionPaths('/state', SESSION.toUpperCase()), /lowercase UUID/u)
})

test('readers take only whole lines, resume exactly at their cursor, and learn when events rotated', async () => {
  const { dir, paths } = await scratch()
  try {
    let position = { generation: 0, lastSeq: 0 }
    const log = await openEventLog(paths, position, (next) => { position = next }, 400)
    for (let index = 0; index < 3; index += 1) await log.append({ kind: 'assistant', text: `message ${index}` })
    // A line the host is half way through writing is neither parsed nor skipped.
    await appendFile(paths.events, '{"seq":4,"kind":"assis')
    const first = await readEventPage(paths, position.generation, undefined, { maxBytes: 65_536, maxEvents: 2 })
    assert.deepEqual(first.events.map((event) => event.seq), [1, 2])
    assert.equal(first.more, true)
    const rest = await readEventPage(paths, position.generation, first.next, { maxBytes: 65_536, maxEvents: 10 })
    assert.deepEqual(rest.events.map((event) => event.seq), [3])
    assert.deepEqual(parseEventCursor(encodeEventCursor(rest.next)), rest.next)
    await appendFile(paths.events, 'tant","text":"late","at":"x"}\n')
    const late = await readEventPage(paths, position.generation, rest.next, { maxBytes: 65_536, maxEvents: 10 })
    assert.deepEqual(late.events.map((event) => event.seq), [4])
    await log.close()
    const reopened = await openEventLog(paths, { generation: 0, lastSeq: 4 }, (next) => { position = next }, 400)
    for (let index = 0; index < 6; index += 1) await reopened.append({ kind: 'assistant', text: `rotating ${index}` })
    await reopened.close()
    assert.ok(position.generation >= 1)
    const after = await readEventPage(paths, position.generation, late.next, { maxBytes: 65_536, maxEvents: 50 })
    assert.equal(after.rotated, true)
    assert.ok(after.events.every((event) => event.seq > 4))
    assert.deepEqual(parseEventCursor('1.2'), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a host lock is live only while its heartbeat is fresh, and a stale one is taken over', async () => {
  const { dir, paths } = await scratch()
  try {
    const first = await acquireHostLock(paths.lock, 'sha256:a')
    assert.ok(first)
    assert.equal(await acquireHostLock(paths.lock, 'sha256:a'), undefined, 'a second host is refused')
    assert.equal(await first.heartbeat(), true)
    const record = (await readHostLock(paths.lock))!
    assert.equal(hostLockIsStale(record), false)
    assert.equal(hostLockIsStale(record, Date.now() + 11_000), true)
    // A pid that is alive does not make an old heartbeat fresh: pids get reused.
    await writeJsonAtomic(paths.lock, { ...record, heartbeatAt: new Date(Date.now() - 60_000).toISOString() })
    const second = await acquireHostLock(paths.lock, 'sha256:b')
    assert.ok(second, 'a stale lock is taken over')
    assert.equal(await first.stillOurs(), false)
    assert.equal(await first.heartbeat(), false, 'the old host learns on its next heartbeat')
    await first.release()
    assert.equal((await readHostLock(paths.lock))?.token, second.record.token, 'releasing someone else\'s lock does nothing')
    await second.release()
    assert.equal(await readHostLock(paths.lock), undefined)
    assert.deepEqual((await readdir(paths.dir)).filter((name) => name.includes('.stale.')), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a request lands once under its command id, and a command outcome is recorded once', async () => {
  const { dir, paths } = await scratch()
  try {
    await mkdir(join(dir, 'commands'))
    assert.equal(await writeRequest(paths, { id: 'cmd-1', kind: 'send', text: 'a', at: '2026-09-22T00:00:02.000Z' }), true)
    assert.equal(await writeRequest(paths, { id: 'cmd-1', kind: 'send', text: 'b', at: '2026-09-22T00:00:03.000Z' }), false)
    await writeRequest(paths, { id: 'cmd-0', kind: 'start', text: 'first', at: '2026-09-22T00:00:01.000Z' })
    await writeFile(join(paths.inbox, 'junk.json'), 'not json')
    await writeFile(join(paths.inbox, 'fresh.json'), '{"half":')
    const old = new Date(Date.now() - 60_000)
    await utimes(join(paths.inbox, 'junk.json'), old, old)
    assert.deepEqual((await listRequests(paths)).map((request) => [request.id, request.text]), [['cmd-0', 'first'], ['cmd-1', 'a']])
    assert.equal((await readdir(paths.inbox)).includes('junk.json'), false, 'old junk is cleared')
    assert.equal((await readdir(paths.inbox)).includes('fresh.json'), true, 'a read that failed a moment ago is retried, not deleted')
    const record = { commandId: 'cmd-9', ownerKey: 'o', tool: 'session_start', sessionId: SESSION, at: 'now' }
    assert.equal(await claimCommand(dir, record), undefined)
    assert.deepEqual(await claimCommand(dir, { ...record, sessionId: 'other' }), record)
    await assert.rejects(claimCommand(dir, { ...record, commandId: '../x' }), /command id/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('status is derived at read time and fits 8 KB with status and nextCursor first', async () => {
  const { dir, paths } = await scratch()
  try {
    let position = { generation: 0, lastSeq: 0 }
    const log = await openEventLog(paths, position, (next) => { position = next })
    for (let index = 0; index < 40; index += 1) {
      await log.append({ kind: 'tool', name: index % 2 ? 'Edit' : 'Bash', summary: `step ${index} ${'x'.repeat(250)}` })
    }
    await log.close()
    const state = {
      ...initialCodingSessionState('2026-09-22T00:00:00.000Z'), status: 'working' as const, turn: 1, ...position,
    }
    await writeJsonAtomic(paths.state, state)
    const lost = await deriveCodingStatus(paths, state)
    assert.deepEqual([lost.status, lost.reason], ['interrupted', 'host_lost'], 'working with no heartbeat means the host is gone')
    const held = await acquireHostLock(paths.lock, 'sha256:a')
    const live = await deriveCodingStatus(paths, state)
    assert.equal(live.status, 'working')
    const events = await composeCodingStatus({ paths, meta, state, derived: live, detail: 'events' })
    const text = JSON.stringify(events)
    assert.ok(Buffer.byteLength(text) <= CODING_STATUS_MAX_BYTES, `${Buffer.byteLength(text)} bytes`)
    assert.deepEqual(Object.keys(events).slice(0, 2), ['status', 'nextCursor'])
    assert.equal(events.moreEvents, true)
    const delivered = JSON.parse(await readFile(paths.delivered, 'utf8')) as { cursor: string }
    assert.equal(delivered.cursor, events.nextCursor, 'the bridge remembers what it delivered')
    const summary = await composeCodingStatus({ paths, meta, state, derived: live, detail: 'summary' })
    const counts = (summary.summary as { toolCounts: Record<string, number>; newEvents: number })
    assert.equal(counts.newEvents, 40 - (events.events as unknown[]).length, 'a summary picks up where the last read stopped')
    const quiet = await composeCodingStatus({ paths, meta, state, derived: live, detail: 'summary' })
    assert.equal((quiet.summary as { newEvents: number }).newEvents, 0)
    assert.ok(Buffer.byteLength(JSON.stringify(quiet)) < 600, 'a poll with nothing new stays small')
    await held?.release()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
