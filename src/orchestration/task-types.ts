/**
 * src/orchestration/task-types.ts — Type system for multi-agent task orchestration.
 * Defines statuses, roles, schemas, and valid state transitions.
 */

import { z } from 'zod'

export const TaskStatus = {
  Inbox: 'inbox',
  Assigned: 'assigned',
  InProgress: 'in_progress',
  Review: 'review',
  Done: 'done',
  Failed: 'failed',
  Cancelled: 'cancelled',
  AwaitingApproval: 'awaiting_approval',
} as const

export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus]

export const TaskRole = {
  Orchestrator: 'orchestrator',
  Builder: 'builder',
  Reviewer: 'reviewer',
  Watcher: 'watcher',
  Researcher: 'researcher',
  Debugger: 'debugger',
} as const

export type TaskRole = (typeof TaskRole)[keyof typeof TaskRole]

export interface Task {
  id: string
  parentId: string | null
  threadId: string
  role: TaskRole
  label: string
  status: TaskStatus
  specPath: string | null
  outputPath: string | null
  assignedModel: string | null
  timeoutSeconds: number | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

export interface TaskEvent {
  id: string
  taskId: string
  fromStatus: TaskStatus | null
  toStatus: TaskStatus
  reason: string
  timestamp: number
}

export interface TaskArtifact {
  id: string
  taskId: string
  path: string
  mimeType: string
  createdAt: number
}

export const CreateTaskSchema = z.object({
  parentId: z.string().nullable().default(null),
  threadId: z.string().default('main'),
  role: z.enum([
    'orchestrator', 'builder', 'reviewer',
    'watcher', 'researcher', 'debugger',
  ]),
  label: z.string().min(1),
  specPath: z.string().nullable().default(null),
  outputPath: z.string().nullable().default(null),
  assignedModel: z.string().nullable().default(null),
  timeoutSeconds: z.number().nullable().default(null),
})

export type CreateTaskInput = z.infer<typeof CreateTaskSchema>

export const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  inbox: ['assigned', 'cancelled'],
  assigned: ['in_progress', 'cancelled'],
  in_progress: ['review', 'failed', 'cancelled', 'awaiting_approval'],
  review: ['done', 'in_progress', 'failed'],
  done: [],
  failed: ['inbox'],
  cancelled: [],
  awaiting_approval: ['in_progress', 'cancelled'],
}
