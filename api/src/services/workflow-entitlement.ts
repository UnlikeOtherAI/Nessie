// Workflow access is shared with PA tools. A conversational action must use
// the same entitlement answer as the REST route, never a role-only shortcut.
export {
  canActorReadWorkflowInstallation,
  canActorReadWorkflowRun,
  canActorStartWorkflowRun,
  isWorkflowAdmin,
  workflowInstallationEntitlementFilter,
  type WorkflowInstallationScopeRow,
} from '@nessie/team-admin'
