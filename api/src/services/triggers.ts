// Barrel for the trigger service. Implementation is split by seam:
// - trigger-shared.ts: record mappers, config validators, schedule/target
//   resolution, delivery-dedupe helpers, and the DispatchTriggerResult contract
// - trigger-crud.ts: list/create/get/update/delete/pause/resume/deliveries
// - trigger-activity.ts: what each trigger is running right now
// - trigger-dispatch.ts: dispatchAgentTrigger (agent runs)
// - trigger-dispatch-workflow.ts: dispatchWorkflowTrigger (workflow runs)
export {
  createAgentTrigger,
  createWorkflowTrigger,
  deleteAgentTrigger,
  getAgentTrigger,
  listAgentTriggerDeliveries,
  listAgentTriggers,
  listOrganizationTriggers,
  listScheduledTriggers,
  listWorkflowInstallationTriggers,
  pauseAgentTrigger,
  resumeAgentTrigger,
  updateAgentTrigger,
} from './trigger-crud.js'
export { listAgentTriggerActivity } from './trigger-activity.js'
export { dispatchAgentTrigger, type DispatchTriggerResult } from './trigger-dispatch.js'
export {
  reauthorizeAgentTrigger,
  type ReauthorizeTriggerResult,
} from './trigger-reauthorize.js'
