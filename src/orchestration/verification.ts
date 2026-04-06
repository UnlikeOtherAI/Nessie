import { db } from '../db/database.js'
import type { TaskLedger } from './task-ledger.js'
import { getRolePolicy } from './role-registry.js'
import type { TaskRole } from './task-types.js'

export interface ReviewResult {
  id: string
  taskId: string
  reviewerTaskId: string | null
  verdict: 'pass' | 'fail'
  reason: string
  repairInstructions: string | null
  escalated: boolean
  createdAt: number
}

export interface VerificationConfig {
  maxRepairIterations: number
}

type ReviewRow = {
  id: string
  task_id: string
  reviewer_task_id: string | null
  verdict: string
  reason: string
  repair_instructions: string | null
  created_at: number
}

function rowToReview(row: ReviewRow, escalated: boolean): ReviewResult {
  return {
    id: row.id,
    taskId: row.task_id,
    reviewerTaskId: row.reviewer_task_id,
    verdict: row.verdict as 'pass' | 'fail',
    reason: row.reason,
    repairInstructions: row.repair_instructions,
    escalated,
    createdAt: row.created_at,
  }
}

const DEFAULT_CONFIG: VerificationConfig = { maxRepairIterations: 3 }

export class VerificationGate {
  private ledger: TaskLedger
  private config: VerificationConfig

  constructor(ledger: TaskLedger, config?: Partial<VerificationConfig>) {
    this.ledger = ledger
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  submitReview(
    taskId: string,
    verdict: 'pass' | 'fail',
    reason: string,
    reviewerTaskId?: string,
    repairInstructions?: string,
  ): ReviewResult {
    if (verdict === 'fail' && !repairInstructions) {
      throw new Error('repairInstructions required when verdict is fail')
    }

    if (reviewerTaskId) {
      const reviewer = this.ledger.getTask(reviewerTaskId)
      if (!reviewer) throw new Error(`Reviewer task not found: ${reviewerTaskId}`)
      const policy = getRolePolicy(reviewer.role as TaskRole)
      if (policy.requiresReview) {
        throw new Error(
          `Task ${reviewerTaskId} (role: ${reviewer.role}) cannot act as reviewer`,
        )
      }
    }

    const task = this.ledger.getTask(taskId)
    if (!task) throw new Error(`Task not found: ${taskId}`)
    if (task.status !== 'review') {
      throw new Error(
        `Task ${taskId} is not in review status (current: ${task.status})`,
      )
    }

    const id = crypto.randomUUID()
    const now = Date.now()
    const instructions = verdict === 'fail' ? (repairInstructions ?? null) : null

    db.prepare(
      'INSERT INTO task_reviews'
      + ' (id, task_id, reviewer_task_id, verdict, reason,'
      + ' repair_instructions, created_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, taskId, reviewerTaskId ?? null, verdict, reason, instructions, now)

    const escalated = verdict === 'fail' && this.isEscalated(taskId)

    return {
      id,
      taskId,
      reviewerTaskId: reviewerTaskId ?? null,
      verdict,
      reason,
      repairInstructions: instructions,
      escalated,
      createdAt: now,
    }
  }

  getReviewHistory(taskId: string): ReviewResult[] {
    const rows = db.prepare(
      'SELECT * FROM task_reviews WHERE task_id = ? ORDER BY created_at ASC',
    ).all(taskId) as ReviewRow[]
    const escalated = this.isEscalated(taskId)
    return rows.map(r => rowToReview(r, escalated))
  }

  getRepairCount(taskId: string): number {
    const row = db.prepare(
      'SELECT COUNT(*) as cnt FROM task_reviews'
      + ' WHERE task_id = ? AND verdict = ?',
    ).get(taskId, 'fail') as { cnt: number }
    return row.cnt
  }

  isEscalated(taskId: string): boolean {
    return this.getRepairCount(taskId) >= this.config.maxRepairIterations
  }

  hasPassingReview(taskId: string): boolean {
    const row = db.prepare(
      'SELECT COUNT(*) as cnt FROM task_reviews'
      + ' WHERE task_id = ? AND verdict = ?',
    ).get(taskId, 'pass') as { cnt: number }
    return row.cnt > 0
  }
}
