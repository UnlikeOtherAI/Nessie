import type { KnowledgePageRecord } from '../../facades/knowledge/hooks'
import type { TaskStatus } from '../../facades/tasks/hooks'
import type { PillTone } from '../primitives/Pill'

/**
 * Status → tone for the two chips this feature area hand-rolled as bare spans
 * with their own one-off `0.14em` tracking: the task-row status in the
 * backlog and the document status in a task's Documents panel. One map per
 * domain, imported by both, per `todo-presentation.ts`'s model.
 */

export const taskStatusTone = (status: TaskStatus): PillTone => {
  switch (status) {
    case 'done':
      return 'success'
    case 'failed':
      return 'danger'
    case 'cancelled':
      return 'muted'
    case 'in_progress':
      return 'accent'
    case 'review':
    case 'awaiting_approval':
      return 'warning'
    case 'assigned':
      return 'info'
    case 'inbox':
      return 'muted'
  }
}

/**
 * Mirrors `components/features/knowledge/page-status.ts`'s `pageStatusTone`
 * (draft/published/archived → warning/success/muted) in `Pill`'s tone
 * vocabulary rather than that file's Tailwind-class map — that file is out of
 * this feature's ownership, so the semantic mapping is restated here instead
 * of forked as a second class-based lookup.
 */
export const taskDocumentStatusTone = (status: KnowledgePageRecord['status']): PillTone => {
  switch (status) {
    case 'published':
      return 'success'
    case 'archived':
      return 'muted'
    case 'draft':
      return 'warning'
  }
}
