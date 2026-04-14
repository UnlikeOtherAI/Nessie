/**
 * src/workflow/store.ts — JSON-based persistence for workflows.
 * Each workspace has its own workflows.json file.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import type {
  Workflow,
  WorkflowTask,
  CreateWorkflowInput,
  UpdateWorkflowInput,
  CreateTaskInput,
  UpdateTaskInput,
  WorkflowTaskStatus,
} from './types.js'
import { validateDag } from './types.js'

const WORKFLOW_DIR = process.env.NESSIE_WORKFLOW_DIR ?? `${process.env.HOME}/.nessie/workflows`

interface WorkflowStore {
  workflows: Workflow[]
  tasks: Record<string, WorkflowTask[]>  // workflowId -> tasks
}

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
    return JSON.parse(data) as WorkflowStore
  } catch {
    return { workflows: [], tasks: {} }
  }
}

function saveStore(workspaceId: string, store: WorkflowStore): void {
  ensureDir(workspaceId)
  const path = getStorePath(workspaceId)
  writeFileSync(path, JSON.stringify(store, null, 2), 'utf8')
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
    const workflow = store.workflows[index]
    const updated: Workflow = {
      ...workflow,
      ...input,
      updatedAt: Date.now(),
    }
    if (input.status === 'completed') {
      updated.completedAt = Date.now()
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

    // Validate dependencies exist
    const existingTasks = store.tasks[input.workflowId] ?? []
    for (const depId of input.dependencies) {
      if (!existingTasks.some(t => t.id === depId) && depId !== input.workflowId) {
        // Also check if it's the workflow itself (self-reference check)
        // Actually dependencies should be other tasks, not the workflow itself
      }
    }

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
      return { error: dagErrors[0].message }
    }

    store.tasks[input.workflowId].push(newTask)
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
      const index = tasks.findIndex(t => t.id === id)
      if (index !== -1) {
        const task = tasks[index]
        const updated: WorkflowTask = {
          ...task,
          ...input,
          updatedAt: Date.now(),
        }
        if (input.status === 'completed' || input.status === 'failed') {
          updated.completedAt = Date.now()
          if (input.status === 'completed') {
            updated.result = updated.result ?? 'Completed'
          }
        }
        tasks[index] = updated

        // Update workflow timestamp
        const workflow = store.workflows.find(w => w.id === task.workflowId)
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
      const index = tasks.findIndex(t => t.id === id)
      if (index !== -1) {
        const task = tasks[index]
        const status: WorkflowTaskStatus = error ? 'failed' : 'completed'
        const updated: WorkflowTask = {
          ...task,
          status,
          result: result ?? task.result,
          error: error ?? task.error,
          updatedAt: Date.now(),
          completedAt: Date.now(),
        }
        tasks[index] = updated
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
