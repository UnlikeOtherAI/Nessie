import { z } from 'zod'

import { TimestampSchema } from './schema-primitives.js'

/**
 * An approval-gate request as the client sees it. Lives here — not
 * `api/src/contracts/approvals.ts` — because the admin (which renders the
 * approvals surface) has no import path into `api/src`; the API contract
 * file re-exports this schema so route handlers keep one import surface
 * (docs/architecture.md, "shared runtime schemas").
 *
 * Deliberately omits `continuationToken`: that field is a resume secret on
 * the Prisma row and must never reach the client. Its absence here is what
 * makes that guarantee enforceable rather than merely true by convention.
 */
export const ApprovalRequestRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  projectId: z.string().uuid().nullable(),
  teamId: z.string().uuid().nullable(),
  channelId: z.string().uuid().nullable(),
  taskId: z.string().uuid().nullable(),
  runId: z.string().uuid().nullable(),
  agentId: z.string().uuid(),
  requesterId: z.string().uuid(),
  action: z.string(),
  reason: z.string(),
  context: z.record(z.string(), z.unknown()).nullable(),
  status: z.string(),
  resolverId: z.string().uuid().nullable(),
  resolvedAt: TimestampSchema.nullable(),
  resolution: z.string().nullable(),
  resolutionNote: z.string().nullable(),
  requiredApproverRole: z.string().nullable(),
  toolName: z.string().nullable(),
  expiresAt: TimestampSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type ApprovalRequestRecord = z.infer<typeof ApprovalRequestRecordSchema>

export const ResolveApprovalBodySchema = z.object({
  resolution: z.enum(['approved', 'rejected']),
  note: z.string().max(2000).optional(),
}).strict()
export type ResolveApprovalBody = z.infer<typeof ResolveApprovalBodySchema>
