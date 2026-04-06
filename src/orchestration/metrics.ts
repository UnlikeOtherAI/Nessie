/**
 * src/orchestration/metrics.ts — Per-task and aggregate metrics.
 */

import { db } from '../db/database.js'

export interface TaskMetrics {
  taskId: string
  durationMs: number | null
  reviewCount: number
  repairDepth: number
  timedOut: boolean
}

export interface AggregateMetrics {
  totalTasks: number
  byStatus: Record<string, number>
  completionRate: number
  failureRate: number
  avgRepairDepth: number
  avgDurationMs: number
}

export function getTaskMetrics(taskId: string): TaskMetrics {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as {
    id: string; status: string; created_at: number
    completed_at: number | null; timeout_seconds: number | null
  } | null
  if (!task) throw new Error(`Task not found: ${taskId}`)

  const reviewRow = db.prepare(
    'SELECT COUNT(*) as cnt FROM task_reviews WHERE task_id = ?',
  ).get(taskId) as { cnt: number }

  const failRow = db.prepare(
    'SELECT COUNT(*) as cnt FROM task_reviews'
    + ' WHERE task_id = ? AND verdict = ?',
  ).get(taskId, 'fail') as { cnt: number }

  const isTerminal = ['done', 'failed', 'cancelled'].includes(task.status)
  const durationMs = isTerminal && task.completed_at
    ? task.completed_at - task.created_at
    : null

  // Check if the last event for a failed task mentions timeout
  const lastEvent = task.status === 'failed'
    ? db.prepare(
      'SELECT reason FROM task_events WHERE task_id = ? ORDER BY timestamp DESC LIMIT 1',
    ).get(taskId) as { reason: string } | null
    : null
  const timedOut = lastEvent?.reason?.toLowerCase().includes('timeout') ?? false

  return {
    taskId,
    durationMs,
    reviewCount: reviewRow.cnt,
    repairDepth: failRow.cnt,
    timedOut,
  }
}

export function getAggregateMetrics(): AggregateMetrics {
  const total = db.prepare('SELECT COUNT(*) as cnt FROM tasks')
    .get() as { cnt: number }

  const statusRows = db.prepare(
    'SELECT status, COUNT(*) as cnt FROM tasks GROUP BY status',
  ).all() as { status: string; cnt: number }[]

  const byStatus: Record<string, number> = {}
  for (const row of statusRows) {
    byStatus[row.status] = row.cnt
  }

  const done = byStatus['done'] ?? 0
  const failed = byStatus['failed'] ?? 0
  const completionRate = total.cnt > 0 ? done / total.cnt : 0
  const failureRate = total.cnt > 0 ? failed / total.cnt : 0

  const avgRepair = db.prepare(
    'SELECT AVG(cnt) as avg FROM ('
    + ' SELECT COUNT(*) as cnt FROM task_reviews'
    + ' WHERE verdict = ? GROUP BY task_id)',
  ).get('fail') as { avg: number | null }

  const avgDur = db.prepare(
    'SELECT AVG(completed_at - created_at) as avg FROM tasks'
    + ' WHERE completed_at IS NOT NULL',
  ).get() as { avg: number | null }

  return {
    totalTasks: total.cnt,
    byStatus,
    completionRate,
    failureRate,
    avgRepairDepth: avgRepair.avg ?? 0,
    avgDurationMs: avgDur.avg ?? 0,
  }
}
