import {
  ApprovalRequestRecordSchema,
  ResolveApprovalBodySchema,
  type ApprovalRequestRecord,
  type ResolveApprovalBody,
} from '@nessie/schemas'

// The approval record and its resolve-body shape live in `@nessie/schemas`
// (`approval-records.ts`) because the admin (which renders the approvals
// surface) has no import path into `api/src`. Re-exported here so route
// modules keep one contract import.
export {
  ApprovalRequestRecordSchema,
  ResolveApprovalBodySchema,
  type ApprovalRequestRecord,
  type ResolveApprovalBody,
}
