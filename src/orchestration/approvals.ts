/**
 * src/orchestration/approvals.ts — Approval gate for high-risk task actions.
 * Tasks in awaiting_approval pause until explicitly approved or rejected.
 */

import { db } from '../db/database.js'
import type { TaskLedger } from './task-ledger.js'
import { TaskStatus } from './task-types.js'

export interface ApprovalRequest {
  id: string
  taskId: string
  reason: string
  requestedBy: string | null
  status: 'pending' | 'approved' | 'rejected'
  resolvedBy: string | null
  resolvedAt: number | null
  createdAt: number
}

type ApprovalRow = {
  id: string
  task_id: string
  reason: string
  requested_by: string | null
  status: string
  resolved_by: string | null
  resolved_at: number | null
  created_at: number
}

function rowToApproval(row: ApprovalRow): ApprovalRequest {
  return {
    id: row.id,
    taskId: row.task_id,
    reason: row.reason,
    requestedBy: row.requested_by,
    status: row.status as ApprovalRequest['status'],
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
  }
}

export class ApprovalGate {
  private ledger: TaskLedger

  constructor(ledger: TaskLedger) {
    this.ledger = ledger
  }

  requestApproval(
    taskId: string,
    reason: string,
    requestedBy?: string,
  ): ApprovalRequest {
    const task = this.ledger.getTask(taskId)
    if (!task) throw new Error(`Task not found: ${taskId}`)
    if (task.status !== TaskStatus.AwaitingApproval) {
      throw new Error(
        `Task ${taskId} is not awaiting approval`
        + ` (current: ${task.status})`,
      )
    }

    const existing = this.getPendingApproval(taskId)
    if (existing) return existing

    const id = crypto.randomUUID()
    const now = Date.now()

    db.prepare(
      'INSERT INTO task_approvals'
      + ' (id, task_id, reason, requested_by, status, created_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, taskId, reason, requestedBy ?? null, 'pending', now)

    return {
      id,
      taskId,
      reason,
      requestedBy: requestedBy ?? null,
      status: 'pending',
      resolvedBy: null,
      resolvedAt: null,
      createdAt: now,
    }
  }

  approveTask(taskId: string, resolvedBy?: string): ApprovalRequest {
    const approval = this.getPendingApproval(taskId)
    if (!approval) {
      throw new Error(`No pending approval for task ${taskId}`)
    }

    const now = Date.now()
    db.prepare(
      'UPDATE task_approvals SET status = ?, resolved_by = ?,'
      + ' resolved_at = ? WHERE id = ?',
    ).run('approved', resolvedBy ?? null, now, approval.id)

    return {
      ...approval,
      status: 'approved',
      resolvedBy: resolvedBy ?? null,
      resolvedAt: now,
    }
  }

  rejectTask(taskId: string, resolvedBy?: string): ApprovalRequest {
    const approval = this.getPendingApproval(taskId)
    if (!approval) {
      throw new Error(`No pending approval for task ${taskId}`)
    }

    const now = Date.now()
    db.prepare(
      'UPDATE task_approvals SET status = ?, resolved_by = ?,'
      + ' resolved_at = ? WHERE id = ?',
    ).run('rejected', resolvedBy ?? null, now, approval.id)

    return {
      ...approval,
      status: 'rejected',
      resolvedBy: resolvedBy ?? null,
      resolvedAt: now,
    }
  }

  getPendingApproval(taskId: string): ApprovalRequest | null {
    const row = db.prepare(
      'SELECT * FROM task_approvals'
      + ' WHERE task_id = ? AND status = ? LIMIT 1',
    ).get(taskId, 'pending') as ApprovalRow | null
    return row ? rowToApproval(row) : null
  }

  listPendingApprovals(): ApprovalRequest[] {
    const rows = db.prepare(
      'SELECT * FROM task_approvals WHERE status = ?'
      + ' ORDER BY created_at ASC',
    ).all('pending') as ApprovalRow[]
    return rows.map(rowToApproval)
  }

  getApprovalHistory(taskId: string): ApprovalRequest[] {
    const rows = db.prepare(
      'SELECT * FROM task_approvals WHERE task_id = ?'
      + ' ORDER BY created_at ASC',
    ).all(taskId) as ApprovalRow[]
    return rows.map(rowToApproval)
  }
}
