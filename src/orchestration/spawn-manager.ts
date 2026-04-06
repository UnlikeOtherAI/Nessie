import { TaskLedger } from './task-ledger.js'
import type { TaskRole } from './task-types.js'
import { TaskStatus, SpawnRequestSchema } from './task-types.js'

export interface SpawnRequest {
  parentTaskId: string | null
  role: TaskRole
  label: string
  toolScope: string[]
  timeoutSeconds: number
  modelOverride?: string
}

export { SpawnRequestSchema }

export interface SpawnResult {
  taskId: string
  accepted: boolean
  reason?: string
}

export interface SpawnConfig {
  maxSpawnDepth: number
  maxChildrenPerAgent: number
  maxConcurrent: number
}

export interface AnnouncePayload {
  taskId: string
  parentTaskId: string | null
  status: 'completed' | 'failed' | 'timeout'
  result: string
  duration: number
  toolCallCount: number
}

const DEFAULT_CONFIG: SpawnConfig = {
  maxSpawnDepth: 3,
  maxChildrenPerAgent: 5,
  maxConcurrent: 3,
}

export class SpawnManager {
  private ledger: TaskLedger
  private config: SpawnConfig
  // NOTE: activeSpawns is in-memory only. After a server restart, in-flight
  // tasks lose their timers. Call hydrate() on startup to mark orphaned
  // in-progress tasks as failed.
  private activeSpawns = new Map<string, { taskId: string; timer: ReturnType<typeof setTimeout> }>()
  private onComplete: (taskId: string, result: AnnouncePayload) => void

  constructor(
    ledger: TaskLedger,
    onComplete: (taskId: string, result: AnnouncePayload) => void,
    config?: Partial<SpawnConfig>,
  ) {
    this.ledger = ledger
    this.onComplete = onComplete
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Hydrate on restart: mark any in-progress tasks as failed since their
   * timers and in-memory state were lost on server restart.
   */
  hydrate(): void {
    const inProgress = this.ledger.getTasksByStatus(TaskStatus.InProgress)
    for (const task of inProgress) {
      try {
        this.ledger.transition(task.id, TaskStatus.Failed, 'Server restarted')
      } catch {
        // Task may not allow this transition — skip silently
      }
    }
  }

  spawn(request: SpawnRequest): SpawnResult {
    if (request.parentTaskId) {
      // Verify parent task exists in ledger (Issue 6)
      const parentTask = this.ledger.getTask(request.parentTaskId)
      if (!parentTask) {
        return {
          taskId: '',
          accepted: false,
          reason: `Parent task not found: ${request.parentTaskId}`,
        }
      }

      const depth = this.getSpawnDepth(request.parentTaskId)
      if (depth >= this.config.maxSpawnDepth) {
        return {
          taskId: '',
          accepted: false,
          reason: `Max spawn depth (${this.config.maxSpawnDepth}) exceeded`,
        }
      }

      const children = this.ledger.getChildTasks(request.parentTaskId)
      if (children.length >= this.config.maxChildrenPerAgent) {
        return {
          taskId: '',
          accepted: false,
          reason: `Max children (${this.config.maxChildrenPerAgent}) exceeded`,
        }
      }
    }

    if (this.activeSpawns.size >= this.config.maxConcurrent) {
      return {
        taskId: '',
        accepted: false,
        reason: `Max concurrent spawns (${this.config.maxConcurrent}) reached`,
      }
    }

    // Clamp timeoutSeconds to [1, 3600]
    const clampedTimeout = Math.max(1, Math.min(3600, request.timeoutSeconds))

    const task = this.ledger.createTask({
      parentId: request.parentTaskId,
      threadId: 'main',
      role: request.role,
      label: request.label,
      assignedModel: request.modelOverride ?? null,
      timeoutSeconds: clampedTimeout,
      specPath: null,
      outputPath: null,
    })

    const timer = setTimeout(() => {
      this.handleTimeout(task.id)
    }, clampedTimeout * 1000)

    this.activeSpawns.set(task.id, { taskId: task.id, timer })

    return { taskId: task.id, accepted: true }
  }

  complete(taskId: string, success: boolean, result: string, toolCallCount: number): void {
    const spawn = this.activeSpawns.get(taskId)
    if (!spawn) return

    clearTimeout(spawn.timer)

    const task = this.ledger.getTask(taskId)
    if (!task) {
      this.activeSpawns.delete(taskId)
      return
    }

    const duration = Date.now() - task.createdAt

    const payload: AnnouncePayload = {
      taskId,
      parentTaskId: task.parentId,
      status: success ? 'completed' : 'failed',
      result,
      duration,
      toolCallCount,
    }

    // Run callback before deleting spawn so the task is still tracked if callback throws
    try {
      this.onComplete(taskId, payload)
    } finally {
      this.activeSpawns.delete(taskId)
    }
  }

  private handleTimeout(taskId: string): void {
    const spawn = this.activeSpawns.get(taskId)
    if (!spawn) return

    const task = this.ledger.getTask(taskId)
    if (!task) {
      this.activeSpawns.delete(taskId)
      return
    }

    const duration = Date.now() - task.createdAt

    const payload: AnnouncePayload = {
      taskId,
      parentTaskId: task.parentId,
      status: 'timeout',
      result: 'Task timed out',
      duration,
      toolCallCount: 0,
    }

    // Run callback before deleting spawn so the task is still tracked if callback throws
    try {
      this.onComplete(taskId, payload)
    } finally {
      this.activeSpawns.delete(taskId)
    }
  }

  getSpawnStatus(): { active: number; limit: number } {
    return { active: this.activeSpawns.size, limit: this.config.maxConcurrent }
  }

  private getSpawnDepth(taskId: string): number {
    let depth = 0
    let currentId: string | null = taskId
    while (currentId) {
      const task = this.ledger.getTask(currentId)
      if (!task || !task.parentId) break
      currentId = task.parentId
      depth++
    }
    return depth
  }

  close(): void {
    for (const spawn of this.activeSpawns.values()) {
      clearTimeout(spawn.timer)
    }
    this.activeSpawns.clear()
  }
}
