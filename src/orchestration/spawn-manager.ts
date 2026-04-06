import { TaskLedger } from './task-ledger.js'
import type { TaskRole } from './task-types.js'

export interface SpawnRequest {
  parentTaskId: string | null
  role: TaskRole
  label: string
  toolScope: string[]
  timeoutSeconds: number
  modelOverride?: string
}

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

  spawn(request: SpawnRequest): SpawnResult {
    if (request.parentTaskId) {
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

    const task = this.ledger.createTask({
      parentId: request.parentTaskId,
      threadId: 'main',
      role: request.role,
      label: request.label,
      assignedModel: request.modelOverride ?? null,
      timeoutSeconds: request.timeoutSeconds,
      specPath: null,
      outputPath: null,
    })

    const timer = setTimeout(() => {
      this.handleTimeout(task.id)
    }, request.timeoutSeconds * 1000)

    this.activeSpawns.set(task.id, { taskId: task.id, timer })

    return { taskId: task.id, accepted: true }
  }

  complete(taskId: string, success: boolean, result: string, toolCallCount: number): void {
    const spawn = this.activeSpawns.get(taskId)
    if (!spawn) return

    clearTimeout(spawn.timer)
    this.activeSpawns.delete(taskId)

    const task = this.ledger.getTask(taskId)
    if (!task) return

    const duration = Date.now() - task.createdAt

    const payload: AnnouncePayload = {
      taskId,
      parentTaskId: task.parentId,
      status: success ? 'completed' : 'failed',
      result,
      duration,
      toolCallCount,
    }

    this.onComplete(taskId, payload)
  }

  private handleTimeout(taskId: string): void {
    const spawn = this.activeSpawns.get(taskId)
    if (!spawn) return

    this.activeSpawns.delete(taskId)

    const task = this.ledger.getTask(taskId)
    if (!task) return

    const duration = Date.now() - task.createdAt

    const payload: AnnouncePayload = {
      taskId,
      parentTaskId: task.parentId,
      status: 'timeout',
      result: 'Task timed out',
      duration,
      toolCallCount: 0,
    }

    this.onComplete(taskId, payload)
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
