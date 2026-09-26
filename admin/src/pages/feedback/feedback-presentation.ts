import type { PillTone } from '../../components/primitives/Pill'

/**
 * The one tone map for a feedback item's send status — `agents/todos/todo-presentation.ts`
 * is the model the kit names for this. Previously a local `StatusChip` inside
 * `FeedbackList.tsx` rendered these as bare coloured text instead of through
 * `Pill`.
 */

const FEEDBACK_STATUS_KEYS: Record<string, 'status.recorded' | 'status.sent' | 'status.failed'> = {
  saved: 'status.recorded',
  submitted: 'status.sent',
  failed: 'status.failed',
}

const FEEDBACK_STATUS_TONES: Record<string, PillTone> = {
  failed: 'danger',
  saved: 'muted',
  submitted: 'accent',
}

export const feedbackStatusKey = (status: string) => FEEDBACK_STATUS_KEYS[status]

export const feedbackStatusTone = (status: string): PillTone => FEEDBACK_STATUS_TONES[status] ?? 'muted'
