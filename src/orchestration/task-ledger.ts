/**
 * src/orchestration/task-ledger.ts — SQLite-backed task ledger.
 * Manages task lifecycle, events, and artifacts for multi-agent orchestration.
 */

import { db } from '../db/database.js'
import {
  type Task,
  type TaskEvent,
  type TaskArtifact,
  type TaskStatus,
  type TaskRole,
  type CreateTaskInput,
  VALID_TRANSITIONS,
} from './task-types.js'

const TERMINAL_STATUSES: TaskStatus[] = ['done', 'failed', 'cancelled']

type TaskRow = {
  id: string
  parent_id: string | null
  thread_id: string
  role: string
  label: string
  status: string
  spec_path: string | null
  output_path: string | null
  assigned_model: string | null
  timeout_seconds: number | null
  created_at: number
  updated_at: number
  completed_at: number | null
}

type EventRow = {
  id: string
  task_id: string
  from_status: string | null
  to_status: string
  reason: string
  timestamp: number
}

type ArtifactRow = {
  id: string
  task_id: string
  path: string
  mime_type: string
  created_at: number
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    parentId: row.parent_id,
    threadId: row.thread_id,
    role: row.role as TaskRole,
    label: row.label,
    status: row.status as TaskStatus,
    specPath: row.spec_path,
    outputPath: row.output_path,
    assignedModel: row.assigned_model,
    timeoutSeconds: row.timeout_seconds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }
}

function recordEvent(
  taskId: string,
  fromStatus: TaskStatus | null,
  toStatus: TaskStatus,
  reason: string,
): void {
  const id = crypto.randomUUID()
  const now = Date.now()
  db.prepare(
    'INSERT INTO task_events (id, task_id, from_status, to_status, reason, timestamp)'
    + ' VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, taskId, fromStatus, toStatus, reason, now)
}

export class TaskLedger {
  createTask(input: CreateTaskInput): Task {
    const id = crypto.randomUUID()
    const now = Date.now()
    const status: TaskStatus = 'inbox'

    db.prepare(
      'INSERT INTO tasks'
      + ' (id, parent_id, thread_id, role, label, status,'
      + ' spec_path, output_path, assigned_model, timeout_seconds,'
      + ' created_at, updated_at, completed_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id, input.parentId, input.threadId, input.role, input.label, status,
      input.specPath, input.outputPath, input.assignedModel, input.timeoutSeconds,
      now, now, null,
    )

    recordEvent(id, null, status, 'Task created')

    return {
      id,
      parentId: input.parentId,
      threadId: input.threadId,
      role: input.role as TaskRole,
      label: input.label,
      status,
      specPath: input.specPath,
      outputPath: input.outputPath,
      assignedModel: input.assignedModel,
      timeoutSeconds: input.timeoutSeconds,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    }
  }

  transition(taskId: string, toStatus: TaskStatus, reason: string): Task {
    const task = this.getTask(taskId)
    if (!task) {
      throw new Error(`Task not found: ${taskId}`)
    }

    const allowed = VALID_TRANSITIONS[task.status]
    if (!allowed.includes(toStatus)) {
      throw new Error(
        `Invalid transition: ${task.status} -> ${toStatus}`
        + ` (allowed: ${allowed.join(', ') || 'none'})`,
      )
    }

    const now = Date.now()
    const completedAt = TERMINAL_STATUSES.includes(toStatus) ? now : task.completedAt

    db.prepare(
      'UPDATE tasks SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?',
    ).run(toStatus, now, completedAt, taskId)

    recordEvent(taskId, task.status, toStatus, reason)

    return { ...task, status: toStatus, updatedAt: now, completedAt }
  }

  getTask(taskId: string): Task | null {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | null
    return row ? rowToTask(row) : null
  }

  getTasksByStatus(status: TaskStatus): Task[] {
    const rows = db.prepare(
      'SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC',
    ).all(status) as TaskRow[]
    return rows.map(rowToTask)
  }

  getChildTasks(parentId: string): Task[] {
    const rows = db.prepare(
      'SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at DESC',
    ).all(parentId) as TaskRow[]
    return rows.map(rowToTask)
  }

  getAllTasks(limit = 100): Task[] {
    const rows = db.prepare(
      'SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?',
    ).all(limit) as TaskRow[]
    return rows.map(rowToTask)
  }

  getTaskEvents(taskId: string): TaskEvent[] {
    const rows = db.prepare(
      'SELECT * FROM task_events WHERE task_id = ? ORDER BY timestamp ASC',
    ).all(taskId) as EventRow[]
    return rows.map(r => ({
      id: r.id,
      taskId: r.task_id,
      fromStatus: r.from_status as TaskStatus | null,
      toStatus: r.to_status as TaskStatus,
      reason: r.reason,
      timestamp: r.timestamp,
    }))
  }

  addArtifact(taskId: string, path: string, mimeType: string): TaskArtifact {
    const task = this.getTask(taskId)
    if (!task) {
      throw new Error(`Task not found: ${taskId}`)
    }

    const id = crypto.randomUUID()
    const now = Date.now()

    db.prepare(
      'INSERT INTO task_artifacts (id, task_id, path, mime_type, created_at)'
      + ' VALUES (?, ?, ?, ?, ?)',
    ).run(id, taskId, path, mimeType, now)

    return { id, taskId, path, mimeType, createdAt: now }
  }

  getArtifacts(taskId: string): TaskArtifact[] {
    const rows = db.prepare(
      'SELECT * FROM task_artifacts WHERE task_id = ? ORDER BY created_at ASC',
    ).all(taskId) as ArtifactRow[]
    return rows.map(r => ({
      id: r.id,
      taskId: r.task_id,
      path: r.path,
      mimeType: r.mime_type,
      createdAt: r.created_at,
    }))
  }
}
