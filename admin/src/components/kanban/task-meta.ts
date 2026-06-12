import type { TaskPriority } from '../../facades/tasks/hooks'

// Priority presentation shared by the card chip and the detail dialog control.
export const PRIORITY_ORDER: TaskPriority[] = ['low', 'medium', 'high', 'urgent']

export const PRIORITY_LABEL: Record<TaskPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
}

// Signal-bar icon tint per level — a blue → green → orange → red ramp, all via
// theme tokens (no raw colours). Used by the card glyph and the dialog control.
export const PRIORITY_SIGNAL: Record<TaskPriority, string> = {
  low: 'text-[color:var(--info)]',
  medium: 'text-[color:var(--success)]',
  high: 'text-[color:var(--warning)]',
  urgent: 'text-[color:var(--danger)]',
}

// Deadlines are date-only, stored as UTC midnight; format and compare in UTC so
// the displayed day never drifts with the viewer's timezone.
export const formatDueDate = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })

export const isOverdue = (iso: string): boolean => iso.slice(0, 10) < new Date().toISOString().slice(0, 10)

// <input type="date"> works in YYYY-MM-DD; the record carries a full ISO string.
export const toDateInputValue = (iso: string | null): string => (iso ? iso.slice(0, 10) : '')

export const fromDateInputValue = (value: string): string | null =>
  value ? new Date(`${value}T00:00:00.000Z`).toISOString() : null
