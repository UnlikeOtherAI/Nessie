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
  /** Override lane for this spawn (e.g. from resolveNestedAgentLaneForSession). */
  lane?: string
}

export { SpawnRequestSchema }

export interface SpawnResult {
  taskId: string
  accepted: boolean
  reason?: string
  retryAfterMs?: number
}

export interface SpawnConfig {
  maxSpawnDepth: number
  maxChildrenPerAgent: number
  maxConcurrent: number
  /** Queue depth threshold — circuit breaker trips when active spawns >= this. Default: 9. */
  circuitBreakerDepth: number
  /** Oldest-entry wait threshold in ms. Circuit breaker trips when oldest >= this (default: 10 min). */
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
  // Per-lane active spawns: lane name → map of taskId → spawn entry.
  // Allows nested-role tasks to run in parallel across different sessions
  // while a single-lane role (e.g. researcher) respects its own maxConcurrent.
  private laneStates = new Map<string, Map<string, {
    taskId: string; timer: ReturnType<typeof setTimeout>; enqueuedAt: number
  }>>()
  // Maps taskId → lane name so handleTimeout / complete can clean up the right lane entry.
  private taskLanes = new Map<string, string>()
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

  /**
   * Resolve the lane key for a spawn request. Uses the request's explicit `lane`
   * field if provided; otherwise falls back to deriving a lane from the role via
   * the lanes module.
   */
  private resolveLane(request: SpawnRequest): string {
    if (request.lane) return request.lane
    // Per-session nested lane: scope to the parent's threadId so that
    // long-running nested tasks don't block other sessions' nested work.
    if (request.role === 'researcher') {
      if (request.parentTaskId) {
        const parent = this.ledger.getTask(request.parentTaskId)
        if (parent?.threadId && parent.threadId !== 'main') {
          return `nested:${parent.threadId}`
        }
      }
      // No parent / no session: fallback to bare 'nested' for legacy/cron paths.
      return 'nested'
    }
    return request.role
  }

  /** Count active spawns for a given lane. */
  private activeInLane(lane: string): number {
    return this.laneStates.get(lane)?.size ?? 0
  }

  spawn(request: SpawnRequest): SpawnResult {
    const lane = this.resolveLane(request)

    // Circuit breaker: fail fast when the GLOBAL queue is saturated.
    // This is a system-wide guard, not per-lane.
    const totalActive = Array.from(this.laneStates.values()).reduce((s, m) => s + m.size, 0)
    if (totalActive >= this.config.circuitBreakerDepth) {
      const retryAfterMs = Math.min(this.config.circuitBreakerWaitMs, 30_000)
      return {
        taskId: '',
        accepted: false,
        reason: `Circuit breaker: queue depth ${totalActive} >= ${this.config.circuitBreakerDepth}`,
        retryAfterMs,
      }
    }

    const oldestWaitMs = this.getOldestEntryWaitMs()
    if (oldestWaitMs !== null && oldestWaitMs >= this.config.circuitBreakerWaitMs) {
      const retryAfterMs = Math.min(this.config.circuitBreakerWaitMs, 30_000)
      return {
        taskId: '',
        accepted: false,
        reason: `Circuit breaker: oldest entry wait ${oldestWaitMs}ms >= ${this.config.circuitBreakerWaitMs}ms`,
        retryAfterMs,
      }
    }

    // Inherit threadId from parent to preserve session chains across depths.
    // e.g. agent:main:sub:x → spawned child gets threadId 'agent:main:sub:x'
    // so resolveLane() can correctly scope nested:<threadId> at all depth levels.
    let parentThreadId = 'main'
    if (request.parentTaskId) {
      const parentTask = this.ledger.getTask(request.parentTaskId)
      if (!parentTask) {
        return {
          taskId: '',
          accepted: false,
          reason: `Parent task not found: ${request.parentTaskId}`,
        }
      }
      parentThreadId = parentTask.threadId

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

    // Per-lane maxConcurrent: each lane gets its own concurrency allowance.
    // e.g. 'researcher' lane won't block 'nested:sess:abc' lane.
    if (this.activeInLane(lane) >= this.config.maxConcurrent) {
      return {
        taskId: '',
        accepted: false,
        reason: `Max concurrent spawns for lane '${lane}' (${this.config.maxConcurrent}) reached`,
      }
    }

    const clampedTimeout = Math.max(1, Math.min(3600, request.timeoutSeconds))

    const task = this.ledger.createTask({
      parentId: request.parentTaskId,
      threadId: parentThreadId,
      role: request.role,
      label: request.label,
      assignedModel: request.modelOverride ?? null,
      timeoutSeconds: clampedTimeout,
      specPath: null,
      outputPath: null,
    })

    const now = Date.now()
    const timer = setTimeout(() => {
      this.handleTimeout(task.id, lane)
    }, clampedTimeout * 1000)

    if (!this.laneStates.has(lane)) this.laneStates.set(lane, new Map())
    this.laneStates.get(lane)!.set(task.id, { taskId: task.id, timer, enqueuedAt: now })
    this.taskLanes.set(task.id, lane)

    return { taskId: task.id, accepted: true }
  }

  complete(taskId: string, success: boolean, result: string, toolCallCount: number): void {
    const lane = this.taskLanes.get(taskId)
    const laneMap = lane ? this.laneStates.get(lane) : undefined
    const spawn = laneMap?.get(taskId)
    if (!spawn) return

    clearTimeout(spawn.timer)

    const task = this.ledger.getTask(taskId)
    if (!task) {
      if (laneMap) laneMap.delete(taskId)
      this.taskLanes.delete(taskId)
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

    try {
      this.onComplete(taskId, payload)
    } finally {
      if (laneMap) laneMap.delete(taskId)
      this.taskLanes.delete(taskId)
    }
  }

  private handleTimeout(taskId: string, lane: string): void {
    const laneMap = this.laneStates.get(lane)
    const spawn = laneMap?.get(taskId)
    if (!spawn) return

    const task = this.ledger.getTask(taskId)
    if (!task) {
      if (laneMap) laneMap.delete(taskId)
      this.taskLanes.delete(taskId)
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

    try {
      this.onComplete(taskId, payload)
    } finally {
      if (laneMap) laneMap.delete(taskId)
      this.taskLanes.delete(taskId)
    }
  }

  getSpawnStatus(): { active: number; limit: number } {
    const totalActive = Array.from(this.laneStates.values()).reduce((s, m) => s + m.size, 0)
    return { active: totalActive, limit: this.config.maxConcurrent }
  }

  /**
   * Returns the age in ms of the oldest active spawn across all lanes, or null if no active spawns.
   */
  private getOldestEntryWaitMs(): number | null {
    let oldest = Infinity
    for (const laneMap of this.laneStates.values()) {
      for (const spawn of laneMap.values()) {
        if (spawn.enqueuedAt < oldest) oldest = spawn.enqueuedAt
      }
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
    for (const laneMap of this.laneStates.values()) {
      for (const spawn of laneMap.values()) {
        clearTimeout(spawn.timer)
      }
    }
    this.laneStates.clear()
    this.taskLanes.clear()
  }
}