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

const remedies: Record<string, string> = {
  waiting_for_capacity: 'Waiting for a free processor slot.',
  capacity: 'Waiting for a free processor slot.',
  processor_offline: 'Waiting for the selected local processor to reconnect.',
  processor_offline_prolonged: 'The local processor has been offline for over 30 minutes. Start it on its device to continue.',
  processor_paused: 'The processor is paused. Resume it on its device or in the controls below.',
  resource_paused: 'The processor is paused. Resume its shared resource to continue.',
  waiting_for_stop_confirmation: 'Waiting for the device to confirm that its last request stopped.',
  termination_uncertain: 'The device cannot confirm that generation stopped. Resolve the occupied slot on that device.',
  blocked_dependency: 'An earlier prerequisite has no result. Retry it, or edit this item’s prerequisites.',
  input_too_large: 'This item does not fit the selected model’s context. Select fewer fields or choose a larger context.',
  processor_output_too_large: 'The model reached its output limit. Narrow the requested result and retry.',
  processor_binding_changed: 'The selected model connection changed. Select the processor again before resuming.',
  processor_authorization_changed: 'The processor’s authorization changed. Restore access and select it again.',
  processor_needs_reauthorization: 'The selected model needs attention. Check its connection and authorization.',
  subscription_needs_reauthorization: 'Reconnect the selected model subscription before resuming.',
  processor_search_setup_required: 'Configure and approve Ollama search on the selected executor, then retry.',
  processor_search_unsupported: 'This processor does not expose configured search. Choose a supported processor or turn search off.',
  processor_search_unavailable: 'The configured search is unavailable. Check its account, quota and connection before retrying.',
  search_credentials_missing: 'Add an Ollama search credential on the selected executor, then retry.',
  search_credentials_rejected: 'The Ollama search credential was rejected. Replace it on the selected executor.',
  search_quota_exhausted: 'The Ollama search quota is exhausted. Wait for it to reset or review that account’s quota.',
  search_result_too_large: 'The search response is too large. Narrow the research request before retrying.',
  search_invalid_response: 'Ollama search returned an invalid response. Check its service and retry.',
  processor_outcome_unknown: 'The last request’s result was lost. Retry explicitly if it is safe to run that item again.',
  processor_failed: 'The processor could not finish this item. Check its connection and review the instructions before retrying.',
  retry_limit_reached: 'This item reached its retry limit. Review it and retry explicitly, or skip it.',
  source_revision_changed: 'The pinned source is unavailable or changed. Create a set with the intended source version.',
  processor_budget_blocked: 'The current budget does not permit this processor. Review the budget or select another model.',
  processor_run_budget_reached: 'This item reached the run limit. Narrow its instructions before retrying.',
}

export const taskSetReason = (reason: string): string => remedies[reason] ?? reason

export const taskSetProgress = (set: TaskSetRecord): string =>
  `${set.completedItems.toLocaleString()} of ${set.totalItems.toLocaleString()} completed`

export const taskSetDocumentPath = (pageId: string): string =>
  `/knowledge-base?pageId=${encodeURIComponent(pageId)}`
