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
`)

export interface PersistedMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  threadId: string
  content: string
  timestamp: number
}

export function insertMessage(msg: PersistedMessage): void {
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

export { db }
