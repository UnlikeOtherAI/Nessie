import type { TaskPriority } from '../../facades/tasks/hooks'

// Priority presentation shared by the card chip and the detail dialog control.
export const PRIORITY_ORDER: TaskPriority[] = ['low', 'medium', 'high', 'urgent']

export const PRIORITY_LABEL: Record<TaskPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
}

// Chip background + text, all via theme tokens (no raw colours).
export const PRIORITY_CHIP: Record<TaskPriority, string> = {
  low: 'bg-[color:var(--overlay)] text-[color:var(--tx3)]',
  medium: 'bg-[color:var(--info-soft)] text-[color:var(--info-text)]',
  high: 'bg-[color:var(--warning-soft)] text-[color:var(--warning-text)]',
  urgent: 'bg-[color:var(--danger-soft)] text-[color:var(--danger-text)]',
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
