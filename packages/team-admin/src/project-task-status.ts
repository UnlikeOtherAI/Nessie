import type { TaskStatus } from '@prisma/client'

const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  inbox: ['assigned', 'in_progress', 'review', 'done', 'cancelled'],
  assigned: ['in_progress', 'review', 'done', 'inbox', 'cancelled'],
  in_progress: ['inbox', 'review', 'awaiting_approval', 'done', 'failed', 'cancelled'],
  review: ['inbox', 'in_progress', 'done', 'failed', 'cancelled'],
  awaiting_approval: ['inbox', 'in_progress', 'done', 'failed', 'cancelled'],
  done: ['inbox', 'in_progress', 'review'],
  failed: ['in_progress', 'cancelled'],
  cancelled: ['inbox'],
}

export const isProjectTaskTransitionValid = (from: TaskStatus, to: TaskStatus): boolean =>
  from !== to && (VALID_TRANSITIONS[from]?.includes(to) ?? false)

export const isArchivedProjectTaskStatus = (status: TaskStatus): boolean =>
  status === 'failed' || status === 'cancelled'
