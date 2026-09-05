// The "does this row exist, inside the caller's organization?" checks the
// workflow-template services make before a write are owned by
// `@nessie/team-admin`: `validateWorkflowInstallationChannel` in
// `workflow-authoring.ts` is the same tenancy check the install path already
// runs, and `WorkflowReferenceError` is the one typed class every workflow
// reference-lookup (install, update, run-start) throws. This file re-exports
// them so the existing api-side import path (`./workflow-references.js`)
// keeps working without a second, api-local copy of either.
//
// Run-reference validation deliberately does NOT live here. It is a tenancy
// rule shared by the HTTP start and the personal assistant's start, so it
// lives once in `@nessie/team-admin`'s `workflow-run-references.ts`, which
// the worker can import; a second copy here would be a stale security
// artifact.
export {
  validateWorkflowInstallationChannel,
  WORKFLOW_REFERENCE_ERROR_CODES,
  WorkflowReferenceError,
  type WorkflowReferenceErrorCode,
} from '@nessie/team-admin'
