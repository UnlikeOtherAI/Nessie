import type { TaskSetItemRecord, TaskSetRecord } from '@nessie/schemas'
import { Pill, type PillTone } from '../../primitives/Pill'

type Status = TaskSetRecord['status'] | TaskSetItemRecord['status']
const labels: Record<Status, string> = {
  draft: 'Draft', importing: 'Importing', ready: 'Ready', pending: 'Pending',
  running: 'Processing', waiting: 'Waiting', paused: 'Paused', blocked: 'Needs attention',
  completed: 'Completed', cancelled: 'Cancelled', failed: 'Failed', skipped: 'Skipped',
  blocked_dependency: 'Waiting for a prerequisite',
}
const tones: Partial<Record<Status, PillTone>> = {
  completed: 'success', running: 'accent', failed: 'danger', blocked: 'danger',
  waiting: 'warning', blocked_dependency: 'warning', paused: 'warning',
}

export const TaskSetStatus = ({ status }: { status: Status }) => (
  <Pill tone={tones[status] ?? 'muted'}>{labels[status]}</Pill>
)

export const taskSetTimestamp = (value: string): string => new Date(value).toLocaleString()

export const taskSetProgress = (set: TaskSetRecord): string =>
  `${set.completedItems.toLocaleString()} of ${set.totalItems.toLocaleString()} completed`

export const taskSetDocumentPath = (pageId: string): string =>
  `/knowledge-base?pageId=${encodeURIComponent(pageId)}`
