/**
 * src/db/session-maintenance.test.ts — Unit tests for session maintenance.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  pruneSessionsByCount,
  pruneSessionsByAge,
  runSessionMaintenance,
  initSessionMaintenance,
  getSessionsConfig,
  insertMessage,
  deleteHistory,
} from './database.js'

// Helper: create a temporary in-memory database for testing
// by manipulating the module's db reference (not ideal but necessary for unit tests).
// We use a separate test database file for isolation.

const TEST_DB_PATH = `/tmp/nessie-test-session-maint-${process.pid}.db`

// Override DB_PATH for the duration of these tests
process.env.HELPER_DB_PATH = TEST_DB_PATH

// Re-import to pick up the test DB path
// We use dynamic import to ensure fresh module state
let _db: typeof import('./database.js')
let _pruneSessionsByCount: typeof pruneSessionsByCount
let _pruneSessionsByAge: typeof pruneSessionsByAge
let _runSessionMaintenance: typeof runSessionMaintenance
let _initSessionMaintenance: typeof initSessionMaintenance
let _getSessionsConfig: typeof getSessionsConfig
let _insertMessage: typeof insertMessage
let _deleteHistory: typeof deleteHistory

test.beforeEach(async () => {
  // Dynamically import to get fresh module state with test DB
  const mod = await import('./database.js')
  _db = mod

  // Reset the module-level config flag by re-initializing
  // First, clear any existing data
  _db.deleteHistory()
  _pruneSessionsByCount = _db.pruneSessionsByCount
  _pruneSessionsByAge = _db.pruneSessionsByAge
  _runSessionMaintenance = _db.runSessionMaintenance
  _initSessionMaintenance = _db.initSessionMaintenance
  _getSessionsConfig = _db.getSessionsConfig
  _insertMessage = _db.insertMessage
  _deleteHistory = _db.deleteHistory
})

test.afterEach(() => {
  _db.deleteHistory()
})

// ─── pruneSessionsByCount ─────────────────────────────────────────────────────

test('pruneSessionsByCount: zero when under limit', () => {
  // Insert 3 messages in 2 different threads
  _insertMessage({ id: 'm1', role: 'user', threadId: 'main', content: 'hello', timestamp: 1000 })
  _insertMessage({ id: 'm2', role: 'user', threadId: 'session-a', content: 'hello a', timestamp: 1001 })
  _insertMessage({ id: 'm3', role: 'user', threadId: 'session-b', content: 'hello b', timestamp: 1002 })

  const deleted = _pruneSessionsByCount(5)
  assert.equal(deleted, 0, 'no pruning when under limit')
})

test('pruneSessionsByCount: prunes oldest sessions over limit', () => {
  // Insert 3 sessions (including main)
  _insertMessage({ id: 'm1', role: 'user', threadId: 'main', content: 'main msg', timestamp: 1000 })
  _insertMessage({ id: 'm2', role: 'user', threadId: 'old-session', content: 'old', timestamp: 500 })
  _insertMessage({ id: 'm3', role: 'user', threadId: 'new-session', content: 'new', timestamp: 2000 })

  // Limit of 2 sessions → must prune 1 (old-session)
  const deleted = _pruneSessionsByCount(2)
  assert.equal(deleted, 1, 'pruned one session')

  // old-session should be gone; main and new-session should remain
  const rows = _db.db.prepare(
    'SELECT DISTINCT thread_id FROM messages ORDER BY thread_id',
  ).all() as { thread_id: string }[]
  const remaining = rows.map(r => r.thread_id)
  assert.ok(remaining.includes('main'), 'main should remain')
  assert.ok(remaining.includes('new-session'), 'new-session should remain')
  assert.ok(!remaining.includes('old-session'), 'old-session should be deleted')
})

test('pruneSessionsByCount: never prunes "main" thread', () => {
  // Create many sessions but make sure main has messages too
  _insertMessage({ id: 'm1', role: 'user', threadId: 'main', content: 'main', timestamp: 1000 })
  for (let i = 0; i < 10; i++) {
    _insertMessage({ id: `s${i}`, role: 'user', threadId: `session-${i}`, content: 'msg', timestamp: i })
  }

  // With maxEntries=1, only main should survive
  const deleted = _pruneSessionsByCount(1)
  assert.equal(deleted, 10, 'pruned 10 non-main sessions')

  const rows = _db.db.prepare('SELECT DISTINCT thread_id FROM messages ORDER BY thread_id').all() as { thread_id: string }[]
  assert.equal(rows.length, 1, 'only one thread remains')
  assert.equal(rows[0]!.thread_id, 'main', 'main is the remaining thread')
})

// ─── pruneSessionsByAge ────────────────────────────────────────────────────────

test('pruneSessionsByAge: zero when no old sessions', () => {
  const now = Date.now()
  _insertMessage({ id: 'm1', role: 'user', threadId: 'main', content: 'msg', timestamp: now })
  _insertMessage({ id: 'm2', role: 'user', threadId: 'recent', content: 'recent', timestamp: now })

  const deleted = _pruneSessionsByAge(30) // 30 days
  assert.equal(deleted, 0, 'no pruning when all sessions are recent')
})

test('pruneSessionsByAge: prunes sessions older than maxAgeDays', () => {
  const now = Date.now()
  const oldTimestamp = now - (31 * 24 * 60 * 60 * 1000) // 31 days ago

  _insertMessage({ id: 'm1', role: 'user', threadId: 'main', content: 'main', timestamp: now })
  _insertMessage({ id: 'm2', role: 'user', threadId: 'old-thread', content: 'old', timestamp: oldTimestamp })

  const deleted = _pruneSessionsByAge(30) // 30 days
  assert.equal(deleted, 1, 'pruned one old session')

  const rows = _db.db.prepare('SELECT DISTINCT thread_id FROM messages ORDER BY thread_id').all() as { thread_id: string }[]
  assert.equal(rows.length, 1, 'only main should remain')
  assert.equal(rows[0]!.thread_id, 'main', 'main should remain')
})

test('pruneSessionsByAge: never prunes "main" thread', () => {
  const now = Date.now()
  const oldTimestamp = now - (100 * 24 * 60 * 60 * 1000) // 100 days ago

  _insertMessage({ id: 'm1', role: 'user', threadId: 'main', content: 'ancient main', timestamp: oldTimestamp })
  _insertMessage({ id: 'm2', role: 'user', threadId: 'old-thread', content: 'old', timestamp: oldTimestamp })

  const deleted = _pruneSessionsByAge(30)
  assert.equal(deleted, 1, 'only old-thread was pruned, not main')

  const rows = _db.db.prepare('SELECT DISTINCT thread_id FROM messages ORDER BY thread_id').all() as { thread_id: string }[]
  assert.ok(rows.some(r => r.thread_id === 'main'), 'main should remain')
})

// ─── runSessionMaintenance ─────────────────────────────────────────────────────

test('runSessionMaintenance: enforce mode prunes by count', () => {
  const now = Date.now()
  _insertMessage({ id: 'm1', role: 'user', threadId: 'main', content: 'main', timestamp: now })
  for (let i = 0; i < 10; i++) {
    _insertMessage({ id: `s${i}`, role: 'user', threadId: `session-${i}`, content: 'msg', timestamp: i })
  }

  const result = _runSessionMaintenance({ mode: 'enforce', maxEntries: 3, maxAgeDays: 30 })
  assert.equal(result.countPruned, 8, 'pruned 8 sessions over the limit of 3')
  assert.ok(result.totalSessions >= 3, 'total sessions tracked')
})

test('runSessionMaintenance: warn mode does not prune by count', () => {
  const now = Date.now()
  _insertMessage({ id: 'm1', role: 'user', threadId: 'main', content: 'main', timestamp: now })
  for (let i = 0; i < 5; i++) {
    _insertMessage({ id: `s${i}`, role: 'user', threadId: `session-${i}`, content: 'msg', timestamp: i })
  }

  const result = _runSessionMaintenance({ mode: 'warn', maxEntries: 2, maxAgeDays: 30 })
  assert.equal(result.countPruned, 0, 'warn mode does not prune by count')

  // All sessions should still be present
  const rows = _db.db.prepare('SELECT DISTINCT thread_id FROM messages').all() as { thread_id: string }[]
  assert.equal(rows.length, 6, 'all sessions still present in warn mode')
})

test('runSessionMaintenance: does not run age pruning (count-only)', () => {
  // runSessionMaintenance only handles count pruning; age pruning happens separately
  const now = Date.now()
  const oldTimestamp = now - (100 * 24 * 60 * 60 * 1000) // 100 days ago

  _insertMessage({ id: 'm1', role: 'user', threadId: 'main', content: 'main', timestamp: now })
  _insertMessage({ id: 'm2', role: 'user', threadId: 'old-thread', content: 'old', timestamp: oldTimestamp })

  const result = _runSessionMaintenance({ mode: 'enforce', maxEntries: 100, maxAgeDays: 30 })
  assert.equal(result.countPruned, 0, 'no count pruning when under limit')
  assert.equal(result.agePruned, 0, 'age pruning is NOT run by runSessionMaintenance (separate first-write path)')
})

// ─── initSessionMaintenance ────────────────────────────────────────────────────

test('initSessionMaintenance: sets config and runs count pruning', () => {
  const now = Date.now()
  _insertMessage({ id: 'm1', role: 'user', threadId: 'main', content: 'main', timestamp: now })
  for (let i = 0; i < 5; i++) {
    _insertMessage({ id: `s${i}`, role: 'user', threadId: `session-${i}`, content: 'msg', timestamp: i })
  }

  const result = _initSessionMaintenance({ mode: 'enforce', maxEntries: 2, maxAgeDays: 30 })

  assert.equal(_getSessionsConfig()?.mode, 'enforce')
  assert.equal(_getSessionsConfig()?.maxEntries, 2)
  assert.equal(_getSessionsConfig()?.maxAgeDays, 30)
  assert.equal(result.countPruned, 4, 'pruned excess sessions')
})

test('initSessionMaintenance: subsequent calls use same config', () => {
  _initSessionMaintenance({ mode: 'warn', maxEntries: 100, maxAgeDays: 10 })

  const config = _getSessionsConfig()
  assert.equal(config?.mode, 'warn')
  assert.equal(config?.maxEntries, 100)
  assert.equal(config?.maxAgeDays, 10)
})
