/**
 * src/db/database.ts — SQLite persistence via bun:sqlite.
 * Stores messages and compressed diary entries.
 */

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'fs'

const DB_PATH = process.env.HELPER_DB_PATH ?? `${process.env.HOME}/.helper/agent.db`

mkdirSync(DB_PATH.replace(/\/[^/]+$/, ''), { recursive: true })

const db = new Database(DB_PATH)

db.exec('PRAGMA foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id        TEXT PRIMARY KEY,
    role      TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    content   TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, timestamp);

  CREATE TABLE IF NOT EXISTS diary_entries (
    id              TEXT PRIMARY KEY,
    thread_id       TEXT NOT NULL,
    summary         TEXT NOT NULL,
    importance      INTEGER NOT NULL DEFAULT 2,
    emotional_tone  TEXT,
    entry_type      TEXT NOT NULL DEFAULT 'conversation',
    created_at      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_diary_thread ON diary_entries(thread_id, created_at);
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id               TEXT PRIMARY KEY,
    parent_id        TEXT,
    thread_id        TEXT NOT NULL,
    role             TEXT NOT NULL,
    label            TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'inbox',
    spec_path        TEXT,
    output_path      TEXT,
    assigned_model   TEXT,
    timeout_seconds  INTEGER,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    completed_at     INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_thread ON tasks(thread_id);

  CREATE TABLE IF NOT EXISTS task_events (
    id          TEXT PRIMARY KEY,
    task_id     TEXT NOT NULL,
    from_status TEXT,
    to_status   TEXT NOT NULL,
    reason      TEXT NOT NULL,
    timestamp   INTEGER NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
  );
  CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id);

  CREATE TABLE IF NOT EXISTS task_artifacts (
    id         TEXT PRIMARY KEY,
    task_id    TEXT NOT NULL,
    path       TEXT NOT NULL,
    mime_type  TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
  );
  CREATE INDEX IF NOT EXISTS idx_task_artifacts_task ON task_artifacts(task_id);

  CREATE TABLE IF NOT EXISTS task_reviews (
    id                 TEXT PRIMARY KEY,
    task_id            TEXT NOT NULL REFERENCES tasks(id),
    reviewer_task_id   TEXT,
    verdict            TEXT NOT NULL CHECK(verdict IN ('pass', 'fail')),
    reason             TEXT NOT NULL,
    repair_instructions TEXT,
    created_at         INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_task_reviews_task_id ON task_reviews(task_id);

  CREATE TABLE IF NOT EXISTS task_approvals (
    id             TEXT PRIMARY KEY,
    task_id        TEXT NOT NULL REFERENCES tasks(id),
    reason         TEXT NOT NULL,
    requested_by   TEXT,
    status         TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')),
    resolved_by    TEXT,
    resolved_at    INTEGER,
    created_at     INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_task_approvals_task ON task_approvals(task_id);
  CREATE INDEX IF NOT EXISTS idx_task_approvals_status ON task_approvals(status);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_task_approvals_pending
    ON task_approvals(task_id) WHERE status = 'pending';

  CREATE TABLE IF NOT EXISTS db_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`)


export interface PersistedMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  threadId: string
  content: string
  timestamp: number
}

export function insertMessage(msg: PersistedMessage): void {
  // First-write age pruning: runs once on the first message insert after upgrade.
  _ensureFirstWriteAgePruning()
  db.prepare(
    'INSERT OR REPLACE INTO messages (id, role, thread_id, content, timestamp) VALUES (?, ?, ?, ?, ?)',
  ).run(msg.id, msg.role, msg.threadId, msg.content, msg.timestamp)
}

export function getMessages(threadId: string, limit = 100, beforeTimestamp?: number): PersistedMessage[] {
  const withCursor = 'SELECT id, role, thread_id, content, timestamp FROM messages'
    + ' WHERE thread_id = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT ?'
  const noCursor = 'SELECT id, role, thread_id, content, timestamp FROM messages'
    + ' WHERE thread_id = ? ORDER BY timestamp DESC LIMIT ?'
  const rows = beforeTimestamp
    ? db.prepare(withCursor).all(threadId, beforeTimestamp, limit)
    : db.prepare(noCursor).all(threadId, limit)
  type Row = { id: string; role: string; thread_id: string; content: string; timestamp: number }
  return (rows as Row[])
    .reverse()
    .map(r => ({
      id: r.id, role: r.role as PersistedMessage['role'],
      threadId: r.thread_id, content: r.content, timestamp: r.timestamp,
    }))
}

export function getThreadIds(): string[] {
  const rows = db.prepare('SELECT DISTINCT thread_id FROM messages ORDER BY timestamp DESC').all()
  return (rows as { thread_id: string }[]).map(r => r.thread_id)
}

export interface DiaryEntry {
  id: string
  threadId: string
  summary: string
  importance: number
  emotionalTone?: string
  entryType: string
  createdAt: number
}

export function insertDiaryEntry(entry: DiaryEntry): void {
  const sql = 'INSERT OR REPLACE INTO diary_entries'
    + ' (id, thread_id, summary, importance, emotional_tone, entry_type, created_at)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?)'
  db.prepare(sql).run(
    entry.id, entry.threadId, entry.summary, entry.importance,
    entry.emotionalTone ?? null, entry.entryType, entry.createdAt,
  )
}

export function getDiaryEntries(threadId: string, limit = 100): DiaryEntry[] {
  const sql = 'SELECT id, thread_id, summary, importance, emotional_tone, entry_type, created_at'
    + ' FROM diary_entries WHERE thread_id = ? ORDER BY created_at ASC LIMIT ?'
  type DiaryRow = {
    id: string; thread_id: string; summary: string; importance: number
    emotional_tone: string | null; entry_type: string; created_at: number
  }
  const rows = db.prepare(sql).all(threadId, limit) as DiaryRow[]
  return rows.map(r => ({
    id: r.id, threadId: r.thread_id, summary: r.summary, importance: r.importance,
    emotionalTone: r.emotional_tone ?? undefined, entryType: r.entry_type, createdAt: r.created_at,
  }))
}

export function compressDiary(threadId: string, maxActive = 50): number {
  const countRow = db.prepare('SELECT COUNT(*) as count FROM diary_entries WHERE thread_id = ?')
    .get(threadId) as { count: number }
  const total = countRow.count
  if (total <= maxActive) return 0
  const excess = total - maxActive
  const fadeSql = `UPDATE diary_entries SET summary = '[faded] ' || summary`
    + ` WHERE id IN (`
    + `SELECT id FROM diary_entries WHERE thread_id = ?`
    + ` AND importance <= 2 AND summary NOT LIKE '[faded]%' ORDER BY created_at ASC LIMIT ?)`
  const result = db.prepare(fadeSql).run(threadId, excess)
  return result.changes
}

export interface HistoryEntry {
  id: string
  role: 'user' | 'assistant' | 'system'
  threadId: string
  content: string
  timestamp: number
  type: 'message' | 'diary'
}

export function getThreadHistory(threadId: string, recentMessageCount = 50): HistoryEntry[] {
  const diary = getDiaryEntries(threadId, 100)
  const recent = getMessages(threadId, recentMessageCount)
  const diaryEntries: HistoryEntry[] = diary.map(d => ({
    id: d.id, role: 'system' as const, threadId: d.threadId,
    content: `[memory] ${d.summary}`, timestamp: d.createdAt, type: 'diary' as const,
  }))
  const messageEntries: HistoryEntry[] = recent.map(m => ({
    id: m.id, role: m.role, threadId: m.threadId,
    content: m.content, timestamp: m.timestamp, type: 'message' as const,
  }))
  return [...diaryEntries, ...messageEntries].sort((a, b) => a.timestamp - b.timestamp)
}

// ─── Session Maintenance ───────────────────────────────────────────────────────

// Module-level config for session maintenance (set via initSessionMaintenance).
let _sessionsConfig: SessionMaintenanceConfig | null = null

/**
 * Initialize session maintenance with the given config.
 * Call this once at application startup (before any writes).
 * Returns the result of the load-time pruning pass.
 */
export function initSessionMaintenance(config: SessionMaintenanceConfig): {
  countPruned: number
  agePruned: number
  totalSessions: number
} {
  _sessionsConfig = config
  // Run load-time maintenance: enforce count limit eagerly.
  return runSessionMaintenance(config)
}

/**
 * Returns the current session maintenance config, or null if not yet initialized.
 */
export function getSessionsConfig(): SessionMaintenanceConfig | null {
  return _sessionsConfig
}

// Module-level flag: has the first-write age pruning already run?
let _firstWriteAgePruningDone = false

/**
 * Called from insertMessage to handle the "first write after upgrade" path.
 * Only actually prunes on the very first write; subsequent calls are no-ops.
 */
function _ensureFirstWriteAgePruning(): void {
  if (_firstWriteAgePruningDone) return
  const config = _sessionsConfig
  if (!config) return // Not initialized yet; skip (should not happen in practice)
  _firstWriteAgePruningDone = true
  pruneSessionsByAge(config.maxAgeDays)
}

export function deleteHistory(threadId?: string): number {
  if (threadId) {
    const r1 = db.prepare('DELETE FROM messages WHERE thread_id = ?').run(threadId)
    db.prepare('DELETE FROM diary_entries WHERE thread_id = ?').run(threadId)
    return r1.changes
  }
  const r1 = db.prepare('DELETE FROM messages').run()
  db.prepare('DELETE FROM diary_entries').run()
  return r1.changes
}

// ─── Session Maintenance ───────────────────────────────────────────────────────

export interface SessionMaintenanceConfig {
  mode: 'enforce' | 'warn'
  maxEntries: number
  maxAgeDays: number
}

/**
 * Prune oldest sessions when count exceeds maxEntries.
 * Only prunes sessions that are NOT the 'main' thread.
 * Returns the number of sessions deleted.
 */
export function pruneSessionsByCount(maxEntries: number): number {
  // Count distinct thread_ids
  const countRow = db.prepare(
    'SELECT COUNT(DISTINCT thread_id) as count FROM messages',
  ).get() as { count: number }
  const totalSessions = countRow.count

  if (totalSessions <= maxEntries) {
    return 0
  }

  const excess = totalSessions - maxEntries

  // Get oldest sessions (excluding 'main'), ordered by their earliest message timestamp
  const oldestSessions = db.prepare(`
    SELECT m.thread_id
    FROM messages m
    WHERE m.thread_id != 'main'
    GROUP BY m.thread_id
    ORDER BY MIN(m.timestamp) ASC
    LIMIT ?
  `).all(excess) as { thread_id: string }[]

  let deleted = 0
  for (const { thread_id: threadId } of oldestSessions) {
    const r = db.prepare('DELETE FROM messages WHERE thread_id = ?').run(threadId)
    db.prepare('DELETE FROM diary_entries WHERE thread_id = ?').run(threadId)
    deleted += r.changes
  }

  return deleted
}

/**
 * Prune sessions older than maxAgeDays.
 * Only deletes sessions that are NOT the 'main' thread.
 * Returns the number of sessions deleted.
 */
export function pruneSessionsByAge(maxAgeDays: number): number {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000

  // Find threads where the newest message is older than cutoff AND thread is not 'main'
  const oldThreads = db.prepare(`
    SELECT m.thread_id
    FROM messages m
    GROUP BY m.thread_id
    HAVING MAX(m.timestamp) < ? AND m.thread_id != 'main'
  `).all(cutoff) as { thread_id: string }[]

  let deleted = 0
  for (const { thread_id: threadId } of oldThreads) {
    const r = db.prepare('DELETE FROM messages WHERE thread_id = ?').run(threadId)
    db.prepare('DELETE FROM diary_entries WHERE thread_id = ?').run(threadId)
    deleted += r.changes
  }

  return deleted
}

/**
 * Run session maintenance according to the given config.
 * - count pruning: when mode is 'enforce' and session count > maxEntries, prune oldest
 * - age pruning: NOT performed here — see runFirstWriteSessionPruning() for that
 *
 * Returns an object describing what was done.
 */
export function runSessionMaintenance(config: SessionMaintenanceConfig): {
  countPruned: number
  agePruned: number
  totalSessions: number
} {
  // Count current sessions
  const countRow = db.prepare(
    'SELECT COUNT(DISTINCT thread_id) as count FROM messages',
  ).get() as { count: number }
  const totalSessions = countRow.count

  let countPruned = 0
  if (config.mode === 'enforce' && totalSessions > config.maxEntries) {
    countPruned = pruneSessionsByCount(config.maxEntries)
  }

  // Age pruning is intentionally skipped here — it runs separately on first write
  // via runFirstWriteSessionPruning(), not on every maintenance call.
  const agePruned = 0

  return { countPruned, agePruned, totalSessions }
}

/**
 * Get a metadata value from db_metadata table.
 */
function getMetadata(key: string): string | null {
  const row = db.prepare('SELECT value FROM db_metadata WHERE key = ?').get(key) as
    { value: string } | null
  return row?.value ?? null
}

/**
 * Set a metadata value in db_metadata table.
 */
function setMetadata(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO db_metadata (key, value) VALUES (?, ?)',
  ).run(key, value)
}

const MAINTENANCE_DONE_KEY = 'sessions_maintenance_age_pruned'

/**
 * Run first-write session age pruning.
 * Only performs the age pruning once (tracked in db_metadata).
 * Safe to call on every write; only actually prunes on the first call after upgrade.
 *
 * Returns true if pruning was performed, false if it was already done.
 */
export function runFirstWriteSessionPruning(maxAgeDays: number): boolean {
  const alreadyDone = getMetadata(MAINTENANCE_DONE_KEY)
  if (alreadyDone === 'true') {
    return false
  }

  pruneSessionsByAge(maxAgeDays)
  setMetadata(MAINTENANCE_DONE_KEY, 'true')
  return true
}

export { db }
