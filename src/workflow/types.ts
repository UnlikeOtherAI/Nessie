/**
 * src/workflow/types.ts — Type system for Workflow module.
 * Defines workflow, task, and DAG-related types.
 */

import { z } from 'zod'

// Task statuses for workflows (simplified from orchestration/task-types.ts)
export const WorkflowTaskStatus = {
  Pending: 'pending',
  InProgress: 'in_progress',
  Completed: 'completed',
  Failed: 'failed',
} as const

export type WorkflowTaskStatus = (typeof WorkflowTaskStatus)[keyof typeof WorkflowTaskStatus]

// Workflow status
export const WorkflowStatus = {
  Draft: 'draft',
  Active: 'active',
  Completed: 'completed',
  Archived: 'archived',
} as const

export type WorkflowStatus = (typeof WorkflowStatus)[keyof typeof WorkflowStatus]

// Task within a workflow
export interface WorkflowTask {
  id: string
  workflowId: string
  label: string
  description: string
  status: WorkflowTaskStatus
  ownerAgentId: string | null
  dependencies: string[]  // Task IDs that must complete before this task
  result: string | null
  error: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

// Workflow definition
export interface Workflow {
  id: string
  name: string
  description: string
  status: WorkflowStatus
  ownerAgentId: string
  taskIds: string[]
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

// Input schemas for creating/updating workflows and tasks
export const CreateWorkflowSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  ownerAgentId: z.string().default('main'),
})

export type CreateWorkflowInput = z.infer<typeof CreateWorkflowSchema>

export const UpdateWorkflowSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.enum(['draft', 'active', 'completed', 'archived']).optional(),
})

export type UpdateWorkflowInput = z.infer<typeof UpdateWorkflowSchema>

export const CreateTaskSchema = z.object({
  workflowId: z.string().uuid(),
  label: z.string().min(1),
  description: z.string().default(''),
  ownerAgentId: z.string().nullable().default(null),
  dependencies: z.array(z.string().uuid()).default([]),
})

export type CreateTaskInput = z.infer<typeof CreateTaskSchema>

export const UpdateTaskSchema = z.object({
  label: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed']).optional(),
  ownerAgentId: z.string().nullable().optional(),
})

export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>

// DAG validation
export interface DagValidationError {
  taskId: string
  message: string
}

/**
 * Validate that the task dependencies form a valid DAG (no cycles).
 */
export function validateDag(tasks: WorkflowTask[]): DagValidationError[] {
  const errors: DagValidationError[] = []
  const taskMap = new Map(tasks.map(t => [t.id, t]))
  const visited = new Set<string>()
  const recursionStack = new Set<string>()

  function hasCycle(taskId: string, path: string[]): boolean {
    if (recursionStack.has(taskId)) {
      errors.push({ taskId, message: `Cycle detected: ${[...path, taskId].join(' -> ')}` })
      return true
    }
    if (visited.has(taskId)) {
      return false
    }

    visited.add(taskId)
    recursionStack.add(taskId)

    const task = taskMap.get(taskId)
    if (task) {
      for (const depId of task.dependencies) {
        if (hasCycle(depId, [...path, taskId])) {
          return true
        }
      }
    }

    recursionStack.delete(taskId)
    return false
  }

  for (const task of tasks) {
    if (!visited.has(task.id)) {
      hasCycle(task.id, [])
    }
  }

  // Check for missing dependencies
  for (const task of tasks) {
    for (const depId of task.dependencies) {
      if (!taskMap.has(depId)) {
        errors.push({ taskId: task.id, message: `Missing dependency: ${depId}` })
      }
    }
  }

  return errors
}
