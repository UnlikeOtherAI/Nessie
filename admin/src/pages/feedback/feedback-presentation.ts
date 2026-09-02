import type { PillTone } from '../../components/primitives/Pill'

/**
 * The one tone map for a feedback item's send status — `agents/todos/todo-presentation.ts`
 * is the model the kit names for this. Previously a local `StatusChip` inside
 * `FeedbackList.tsx` rendered these as bare coloured text instead of through
 * `Pill`.
 */

const FEEDBACK_STATUS_LABELS: Record<string, string> = {
  saved: 'Recorded',
  submitted: 'Sent to GitHub',
  failed: 'Send failed',
}

const FEEDBACK_STATUS_TONES: Record<string, PillTone> = {
  failed: 'danger',
  saved: 'muted',
  submitted: 'accent',
}

export const feedbackStatusLabel = (status: string): string => FEEDBACK_STATUS_LABELS[status] ?? status

export const feedbackStatusTone = (status: string): PillTone => FEEDBACK_STATUS_TONES[status] ?? 'muted'
