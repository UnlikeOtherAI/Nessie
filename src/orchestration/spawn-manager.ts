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
  /** Queue depth threshold — circuit breaker trips when active spawns >= this. Default: 9. */
  circuitBreakerDepth: number
  /** Oldest-entry wait threshold in ms — circuit breaker trips when oldest entry wait >= this. Default: 600_000 (10 min). */
  circuitBreakerWaitMs: number
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
  circuitBreakerDepth: 9,
  circuitBreakerWaitMs: 600_000,
}

/**
 * Thrown by SpawnManager when the command lane circuit breaker trips.
 * Indicates the queue is saturated and the caller should retry after retryAfterMs.
 */
export class CommandLaneCircuitBreakerError extends Error {
  readonly retryAfterMs: number | undefined

  constructor(message: string, retryAfterMs?: number) {
    super(message)
    this.name = 'CommandLaneCircuitBreakerError'
    this.retryAfterMs = retryAfterMs
  }
}

export class SpawnManager {
  private ledger: TaskLedger
  private config: SpawnConfig
  // NOTE: activeSpawns is in-memory only. After a server restart, in-flight
  // tasks lose their timers. Call hydrate() on startup to mark orphaned
  // in-progress tasks as failed.
  private activeSpawns = new Map<string, { taskId: string; timer: ReturnType<typeof setTimeout>; enqueuedAt: number }>()
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
    // Circuit breaker: fail fast when queue is saturated to prevent wedging.
    // Check depth first, then oldest-entry wait.
    const active = this.activeSpawns.size
    if (active >= this.config.circuitBreakerDepth) {
      const retryAfter = Math.min(this.config.circuitBreakerWaitMs, 30_000)
      throw new CommandLaneCircuitBreakerError(
        `Circuit breaker: queue depth ${active} >= ${this.config.circuitBreakerDepth}`,
        retryAfter,
      )
    }

    const oldestWaitMs = this.getOldestEntryWaitMs()
    if (oldestWaitMs !== null && oldestWaitMs >= this.config.circuitBreakerWaitMs) {
      const retryAfter = Math.min(this.config.circuitBreakerWaitMs, 30_000)
      throw new CommandLaneCircuitBreakerError(
        `Circuit breaker: oldest entry wait ${oldestWaitMs}ms >= ${this.config.circuitBreakerWaitMs}ms`,
        retryAfter,
      )
    }

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

    const now = Date.now()
    const timer = setTimeout(() => {
      this.handleTimeout(task.id)
    }, clampedTimeout * 1000)

    this.activeSpawns.set(task.id, { taskId: task.id, timer, enqueuedAt: now })

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

  /**
   * Returns the age in ms of the oldest active spawn, or null if no active spawns.
   */
  private getOldestEntryWaitMs(): number | null {
    if (this.activeSpawns.size === 0) return null
    let oldest = Infinity
    for (const spawn of this.activeSpawns.values()) {
      if (spawn.enqueuedAt < oldest) oldest = spawn.enqueuedAt
    }
    return oldest === Infinity ? null : Date.now() - oldest
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