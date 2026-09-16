import { z } from 'zod'

/**
 * Queue constants the knowledge subsystem shares with the worker.
 *
 * Split out of `jobs.ts`, which was already at the 500-line cap: these two
 * belong together — one is a bound the API and the worker must agree on, the
 * other is the topic and payload for the job that carries a transfer past its
 * own bound — and neither is a wire shape, so `knowledge-finder.ts` is the
 * wrong home for them.
 */

// The hard cap on a source attachment the extract job will read: pdf/docx
// parsers need the whole blob buffered, so this bounds memory and CPU
// regardless of kind. It lives here rather than in the worker because the API
// answers "why is this file not indexed?" — `not_indexed/too_large` — from the
// same number, and a cap that disagreed with the worker's would make that
// answer a lie for files between the two values.
export const KNOWLEDGE_EXTRACT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

// `knowledge.transfer` queue job — a cross-space move or copy of more than 500
// pages, which is where a transaction-and-a-request stops being the right
// shape (docs/plans/2026-09-16-documents-finder-ui/transfer.md §5). The worker
// takes the same two tree locks the synchronous path takes, re-runs the
// refusals, and processes the subtree in batches of 200 pages, each batch its
// own transaction in parent-before-child order. Idempotency key:
// kb-transfer:<transferId>.
export const KNOWLEDGE_TRANSFER_TOPIC = 'knowledge.transfer'

export const KnowledgeTransferJobPayloadSchema = z.object({
  organizationId: z.string().uuid(),
  transferId: z.string().uuid(),
  operation: z.enum(['move', 'copy']),
  pageIds: z.array(z.string().uuid()).min(1).max(50),
  target: z.object({
    spaceId: z.string().uuid(),
    parentPageId: z.string().uuid().nullable(),
  }),
  actor: z.object({
    actorId: z.string().min(1),
    actorType: z.enum(['user', 'agent']),
  }),
  // The client showed the audience and sharing consequences and the person
  // accepted them. Carried into the job so the worker's re-run of the refusals
  // judges the same acknowledged act, never a silently widened one.
  acknowledgedAudience: z.literal(true),
})
export type KnowledgeTransferJobPayload = z.infer<typeof KnowledgeTransferJobPayloadSchema>
