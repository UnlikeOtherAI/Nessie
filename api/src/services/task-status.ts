import type { TaskStatus } from '@prisma/client'

// The four Kanban board columns map to the canonical statuses
// {inbox, in_progress, review, done}. Human users drag cards freely between
// those columns, so every column-to-column move must be a legal transition —
// including the backward ones a strict lifecycle would forbid. The extra edges
// below are purely additive; the agent-only paths (awaiting_approval, failed,
// cancelled) keep their original transitions.
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

export const isValidTransition = (from: TaskStatus, to: TaskStatus): boolean =>
  from !== to && (VALID_TRANSITIONS[from]?.includes(to) ?? false)
