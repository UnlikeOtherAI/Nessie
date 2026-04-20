/**
 * src/workflow/store.ts — JSON-based persistence for workflows.
 * Each workspace has its own workflows.json file.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import type {
  Workflow,
  WorkflowTask,
  CreateWorkflowInput,
  UpdateWorkflowInput,
  CreateTaskInput,
  UpdateTaskInput,
  WorkflowTaskStatus,
} from './types.js'
import { validateDag, WorkflowStatus } from './types.js'

const WORKFLOW_DIR = process.env.NESSIE_WORKFLOW_DIR ?? `${process.env.HOME}/.nessie/workflows`

interface WorkflowStore {
  workflows: Workflow[]
  tasks: Record<string, WorkflowTask[]>  // workflowId -> tasks
}

// Write queue to serialize concurrent writes per workspace
const _writeQueue = new Map<string, Promise<void>>()

function getStorePath(workspaceId: string): string {
  return resolve(WORKFLOW_DIR, workspaceId, 'workflows.json')
}

function ensureDir(workspaceId: string): void {
  const dir = resolve(WORKFLOW_DIR, workspaceId)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function loadStore(workspaceId: string): WorkflowStore {
  const path = getStorePath(workspaceId)
  if (!existsSync(path)) {
    return { workflows: [], tasks: {} }
  }
  try {
    const data = readFileSync(path, 'utf8')
    const parsed = JSON.parse(data)
    if (!parsed || typeof parsed !== 'object') {
      return { workflows: [], tasks: {} }
    }
    return parsed as WorkflowStore
  } catch {
    return { workflows: [], tasks: {} }
  }
}

async function saveStoreAsync(workspaceId: string, store: WorkflowStore): Promise<void> {
  ensureDir(workspaceId)
  const path = getStorePath(workspaceId)
  // Write to temp file first, then rename for atomicity
  const tmpPath = `${path}.tmp.${Date.now()}`
  writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf8')
  try {
    // atomic rename
    const { renameSync } = await import('node:fs')
    renameSync(tmpPath, path)
  } catch {
    // fallback: direct write
    writeFileSync(path, JSON.stringify(store, null, 2), 'utf8')
  }
}

function saveStore(workspaceId: string, store: WorkflowStore): void {
  ensureDir(workspaceId)
  // Serialize writes via promise chain
  const prev = _writeQueue.get(workspaceId) ?? Promise.resolve()
  const next = prev.then(() => saveStoreAsync(workspaceId, store))
  _writeQueue.set(workspaceId, next)
  // Don't wait — fire and forget
}

// Default workspace ID
const DEFAULT_WORKSPACE = 'default'

export class WorkflowStoreManager {
  private workspaceId: string

  constructor(workspaceId: string = DEFAULT_WORKSPACE) {
    this.workspaceId = workspaceId
  }

  // Workflow CRUD operations

  createWorkflow(input: CreateWorkflowInput): Workflow {
    const store = loadStore(this.workspaceId)
    const now = Date.now()
    const workflow: Workflow = {
      id: crypto.randomUUID(),
      name: input.name,
      description: input.description,
      status: 'draft',
      ownerAgentId: input.ownerAgentId,
      taskIds: [],
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    }
    store.workflows.push(workflow)
    store.tasks[workflow.id] = []
    saveStore(this.workspaceId, store)
    return workflow
  }

  getWorkflow(id: string): Workflow | null {
    const store = loadStore(this.workspaceId)
    return store.workflows.find(w => w.id === id) ?? null
  }

  listWorkflows(): Workflow[] {
    const store = loadStore(this.workspaceId)
    return store.workflows.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  updateWorkflow(id: string, input: UpdateWorkflowInput): Workflow | null {
    const store = loadStore(this.workspaceId)
    const index = store.workflows.findIndex(w => w.id === id)
    if (index === -1) {
      return null
    }
    const existing = store.workflows[index]!
    const updated: Workflow = {
      id: existing.id,
      name: input.name ?? existing.name,
      description: input.description ?? existing.description,
      status: (input.status ?? existing.status) as WorkflowStatus,
      ownerAgentId: existing.ownerAgentId,
      taskIds: existing.taskIds,
      createdAt: existing.createdAt,
      updatedAt: Date.now(),
      completedAt: input.status === 'completed' ? Date.now() : existing.completedAt,
    }
    store.workflows[index] = updated
    saveStore(this.workspaceId, store)
    return updated
  }

  deleteWorkflow(id: string): boolean {
    const store = loadStore(this.workspaceId)
    const index = store.workflows.findIndex(w => w.id === id)
    if (index === -1) {
      return false
    }
    store.workflows.splice(index, 1)
    delete store.tasks[id]
    saveStore(this.workspaceId, store)
    return true
  }

  // Task CRUD operations

  createTask(input: CreateTaskInput): WorkflowTask | { error: string } {
    const store = loadStore(this.workspaceId)
    const workflow = store.workflows.find(w => w.id === input.workflowId)
    if (!workflow) {
      return { error: `Workflow not found: ${input.workflowId}` }
    }

    const existingTasks = store.tasks[input.workflowId] ?? []

    // Validate DAG
    const newTask: WorkflowTask = {
      id: crypto.randomUUID(),
      workflowId: input.workflowId,
      label: input.label,
      description: input.description,
      status: 'pending',
      ownerAgentId: input.ownerAgentId,
      dependencies: input.dependencies,
      result: null,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      completedAt: null,
    }

    const dagErrors = validateDag([...existingTasks, newTask])
    if (dagErrors.length > 0) {
      return { error: dagErrors[0]!.message }
    }

    const workflowTasks = store.tasks[input.workflowId]
    if (!workflowTasks) {
      store.tasks[input.workflowId] = [newTask]
    } else {
      workflowTasks.push(newTask)
    }
    workflow.taskIds.push(newTask.id)
    workflow.updatedAt = Date.now()
    saveStore(this.workspaceId, store)
    return newTask
  }

  getTask(id: string): WorkflowTask | null {
    const store = loadStore(this.workspaceId)
    for (const tasks of Object.values(store.tasks)) {
      const task = tasks.find(t => t.id === id)
      if (task) return task
    }
    return null
  }

  listTasks(workflowId: string): WorkflowTask[] {
    const store = loadStore(this.workspaceId)
    return store.tasks[workflowId] ?? []
  }

  updateTask(id: string, input: UpdateTaskInput): WorkflowTask | null {
    const store = loadStore(this.workspaceId)
    for (const workflowId of Object.keys(store.tasks)) {
      const tasks = store.tasks[workflowId]
      if (!tasks) continue
      const index = tasks.findIndex(t => t.id === id)
      if (index !== -1) {
        const existing = tasks[index]!
        const updated: WorkflowTask = {
          id: existing.id,
          workflowId: existing.workflowId,
          label: input.label ?? existing.label,
          description: input.description ?? existing.description,
          status: (input.status ?? existing.status) as WorkflowTaskStatus,
          ownerAgentId: input.ownerAgentId !== undefined ? input.ownerAgentId : existing.ownerAgentId,
          dependencies: existing.dependencies,
          result: existing.result,
          error: existing.error,
          createdAt: existing.createdAt,
          updatedAt: Date.now(),
          completedAt: (input.status === 'completed' || input.status === 'failed') ? Date.now() : existing.completedAt,
        }
        tasks[index] = updated

        // Update workflow timestamp
        const workflow = store.workflows.find(w => w.id === existing.workflowId)
        if (workflow) {
          workflow.updatedAt = Date.now()
        }

        saveStore(this.workspaceId, store)
        return updated
      }
    }
    return null
  }

  completeTask(id: string, result?: string, error?: string): WorkflowTask | null {
    const store = loadStore(this.workspaceId)
    for (const workflowId of Object.keys(store.tasks)) {
      const tasks = store.tasks[workflowId]
      if (!tasks) continue
      const index = tasks.findIndex(t => t.id === id)
      if (index !== -1) {
        const existing = tasks[index]!
        const status: WorkflowTaskStatus = error ? 'failed' : 'completed'
        const updated: WorkflowTask = {
          id: existing.id,
          workflowId: existing.workflowId,
          label: existing.label,
          description: existing.description,
          status,
          ownerAgentId: existing.ownerAgentId,
          dependencies: existing.dependencies,
          result: result ?? existing.result ?? null,
          error: error ?? existing.error ?? null,
          createdAt: existing.createdAt,
          updatedAt: Date.now(),
          completedAt: Date.now(),
        }
        tasks[index] = updated

        // Update parent workflow timestamp
        const workflow = store.workflows.find(w => w.id === existing.workflowId)
        if (workflow) {
          workflow.updatedAt = Date.now()
        }

        saveStore(this.workspaceId, store)
        return updated
      }
    }
    return null
  }

  deleteTask(id: string): boolean {
    const store = loadStore(this.workspaceId)
    for (const workflowId of Object.keys(store.tasks)) {
      const tasks = store.tasks[workflowId]
      if (!tasks) continue
      const index = tasks.findIndex(t => t.id === id)
      if (index !== -1) {
        tasks.splice(index, 1)
        // Remove from workflow taskIds
        const workflow = store.workflows.find(w => w.id === workflowId)
        if (workflow) {
          workflow.taskIds = workflow.taskIds.filter(tid => tid !== id)
          workflow.updatedAt = Date.now()
        }
        saveStore(this.workspaceId, store)
        return true
      }
    }
    return false
  }

  // DAG helpers

  getExecutableTasks(workflowId: string): WorkflowTask[] {
    const tasks = this.listTasks(workflowId)
    return tasks.filter(task => {
      if (task.status !== 'pending') return false
      // All dependencies must be completed
      return task.dependencies.every(depId => {
        const dep = tasks.find(t => t.id === depId)
        return dep?.status === 'completed'
      })
    })
  }

  isWorkflowComplete(workflowId: string): boolean {
    const tasks = this.listTasks(workflowId)
    return tasks.length > 0 && tasks.every(t => t.status === 'completed' || t.status === 'failed')
  }
}

// Singleton instance
let _instance: WorkflowStoreManager | null = null

export function getWorkflowStore(workspaceId?: string): WorkflowStoreManager {
  if (!_instance || workspaceId) {
    _instance = new WorkflowStoreManager(workspaceId)
  }
  return _instance
}
