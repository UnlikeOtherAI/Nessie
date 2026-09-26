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
  waiting_for_capacity: 'Waiting for a free model slot.',
  capacity: 'Waiting for a free model slot.',
  processor_offline: 'Waiting for the selected local model to reconnect.',
  processor_offline_prolonged: 'The local model has been offline for over 30 minutes. Start it on its device to continue.',
  processor_paused: 'The model is paused. Resume it on its device or in the controls below.',
  resource_paused: 'The model is paused. Resume its shared resource to continue.',
  waiting_for_stop_confirmation: 'Waiting for the device to confirm that its last request stopped.',
  termination_uncertain: 'The device cannot confirm that generation stopped. Resolve the occupied slot on that device.',
  blocked_dependency: 'An earlier prerequisite has no result. Retry it, or edit this item’s prerequisites.',
  input_too_large: 'This item does not fit the selected model’s context. Select fewer fields or choose a larger context.',
  processor_output_too_large: 'The model reached its output limit. Narrow the requested result and retry.',
  invalid_output: 'The result is not valid JSON for the spreadsheet mapping. Adjust this item’s instructions and retry.',
  invalid_mapping: 'A mapped result field is missing. Correct the mapping or this item’s instructions and retry.',
  output_too_large: 'A value exceeds Excel’s cell limit. Choose JSONL output or reduce the requested fields.',
  invalid_input: 'This item contains invalid data. Review its input before retrying.',
  receiver_delivery_failed: 'Results are saved, but the agent could not be reached. Check its conversation and retry delivery.',
  processor_binding_changed: 'The selected model connection changed. Select the model again before resuming.',
  processor_authorization_changed: 'The model’s authorization changed. Restore access and select it again.',
  processor_needs_reauthorization: 'The selected model needs attention. Check its connection and authorization.',
  processor_resource_setup_required: 'Update and reconnect the local computer to enable shared request limits.',
  resource_missing: 'The shared model connection is missing. Reconnect the local computer.',
  execution_authority_changed: 'The processing agent or conversation is unavailable. Restore access before resuming.',
  subscription_needs_reauthorization: 'Reconnect the selected model subscription before resuming.',
  processor_search_setup_required: 'Configure and approve Ollama search on the selected computer, then retry.',
  processor_search_unsupported: 'This model does not expose configured search. Choose a supported model or turn search off.',
  processor_search_unavailable: 'The configured search is unavailable. Check its account, quota and connection before retrying.',
  processor_search_binding_changed: 'The search computer changed. Review the selected model and retry this item.',
  processor_search_fence_missing: 'The search execution was interrupted. Retry this item after its model stops.',
  processor_unapproved_tool: 'The model requested a tool this model cannot use. Review its research setup and instructions.',
  processor_iteration_limit: 'The item required too many research steps. Narrow its instructions before retrying.',
  search_credentials_missing: 'Add an Ollama search credential on the selected computer, then retry.',
  search_credentials_rejected: 'The Ollama search credential was rejected. Replace it on the selected computer.',
  search_quota_exhausted: 'The Ollama search quota is exhausted. Wait for it to reset or review that account’s quota.',
  search_result_too_large: 'The search response is too large. Narrow the research request before retrying.',
  search_invalid_response: 'Ollama search returned an invalid response. Check its service and retry.',
  processor_outcome_unknown: 'The last request’s result was lost. Retry explicitly if it is safe to run that item again.',
  processor_checkpoint_changed: 'The interrupted request no longer matches its saved state. Review the item and retry explicitly.',
  processor_failed: 'The model could not finish this item. Check its connection and review the instructions before retrying.',
  retry_limit_reached: 'This item reached its retry limit. Review it and retry explicitly, or skip it.',
  source_revision_changed: 'The pinned source is unavailable or changed. Create a set with the intended source version.',
  processor_budget_blocked: 'The current budget does not permit this model. Review the budget or select another model.',
  processor_run_budget_reached: 'This item reached the run limit. Narrow its instructions before retrying.',
  task_set_authorization: 'Your access needs reauthorization. Restore your organisation access before retrying.',
  task_set_source_access: 'Source access changed. Restore permission to read the pinned input before retrying.',
  authorization_lost: 'Permission to read the input or write the output changed. Restore access before retrying.',
  source_unavailable: 'The pinned input file is unavailable. Restore it or create a set from another version.',
  source_changed: 'The pinned input changed. Create a set from the intended file version.',
  unclassified_input: 'The source permissions could not be verified. Ask an administrator to review the input.',
  output_unavailable: 'The output folder is unavailable. Restore access or choose another destination.',
  output_conflict: 'The saved output conflicts with its receipt. Ask an administrator to review this set.',
  output_configuration_changed: 'An output has already been saved with different settings. Review it before creating another set.',
  output_in_progress: 'Saving the completed results.',
  output_claim_lost: 'Another worker is saving the results. Waiting for its saved output.',
  receiver_source_access_required: 'The agent or its conversation cannot read these results. Review its source permissions.',
  receiver_configuration_changed: 'The agent changed during delivery. Review the destination before retrying delivery.',
  receiver_delivery_conflict: 'The delivery record conflicts with this set. Ask an administrator to review the handoff.',
  result_not_complete: 'Some results are unfinished. Review the remaining items before saving output.',
  result_not_classified: 'Result permissions could not be verified. Ask an administrator to review this set.',
  attempt_missing: 'An execution record is missing. Ask an administrator to review this set.',
  cursor_conflict: 'The saved processing position is inconsistent. Ask an administrator to review this set.',
  paused: 'Processing is paused.',
}

export const taskSetReason = (reason: string): string => remedies[reason.toLowerCase()] ?? reason

export const taskSetProgress = (set: TaskSetRecord): string =>
  `${set.completedItems.toLocaleString()} of ${set.totalItems.toLocaleString()} completed`

export const taskSetDocumentPath = (pageId: string): string =>
  `/knowledge-base?pageId=${encodeURIComponent(pageId)}`
