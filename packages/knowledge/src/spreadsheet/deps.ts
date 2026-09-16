import type { Prisma, PrismaClient } from '@prisma/client'
import type { FileService } from '@nessie/runtime'
import {
  SpreadsheetBatchSummarySchema,
  presenceColorFor,
  type DocumentSseEventName,
  type SpreadsheetActor,
  type SpreadsheetAppliedBatch,
  type SpreadsheetIntent,
} from '@nessie/schemas'

import type { SpreadsheetModelCache } from './model-cache.js'
import type {
  AddFileVersionInput,
  CreatePageInput,
  KnowledgePageRecord,
  KnowledgePageVersionRecord,
} from '../types.js'

/** Who is writing, in the terms the journal and the audit row record. */
export type SpreadsheetWriteActor = {
  type: 'user' | 'agent'
  id: string
  displayName: string
  /** Set when an agent wrote this batch; the audit row and presence use it. */
  agentId?: string | null
  /** The run whose first write triggers an automatic "before" version. */
  runId?: string | null
  /** A paired MCP credential acting as its granting human. */
  agentCredentialId?: string | null
}

export const toSpreadsheetActor = (actor: SpreadsheetWriteActor): SpreadsheetActor => ({
  type: actor.type,
  id: actor.id,
  displayName: actor.displayName,
  color: presenceColorFor(actor.agentId ?? actor.id),
  ...(actor.agentId ? { agentId: actor.agentId } : {}),
  ...(actor.runId ? { runId: actor.runId } : {}),
})

/**
 * Publishing is handed in rather than imported: the api replica and the worker
 * each own their own `PgRealtimeTransport`, and a test hands in a recorder.
 */
export type SpreadsheetPublish = (
  event: DocumentSseEventName,
  input: { pageId: string; organizationId: string; data: unknown },
) => Promise<void>

/**
 * Enqueued after a commit, never inside it: compaction is housekeeping and
 * must not fail a batch that already landed.
 */
export type SpreadsheetEnqueueCompaction = (input: {
  pageId: string
  organizationId: string
  seq: number
}) => Promise<void>

export type SpreadsheetAuditWriter = (
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string
    projectId: string | null
    teamId: string | null
    actorType: 'user' | 'agent'
    actorId: string
    action: string
    resourceId: string
    metadata: Record<string, unknown>
  },
) => Promise<void>

export type SpreadsheetServiceDeps = {
  prisma: PrismaClient
  cache: SpreadsheetModelCache
  fileService: FileService
  /**
   * The provider's own writers, handed in rather than constructed here so a
   * version still goes through `indexVersionChunks` — chunks, links and the
   * `knowledge.embed` enqueue — exactly as every other page kind's does. No
   * new indexing code: the body is the text projection and the rest is shared.
   */
  createPage: (input: CreatePageInput) => Promise<KnowledgePageRecord>
  addFileVersion: (input: AddFileVersionInput) => Promise<KnowledgePageVersionRecord | null>
  publish?: SpreadsheetPublish
  enqueueCompaction?: SpreadsheetEnqueueCompaction
  writeAudit?: SpreadsheetAuditWriter
  now?: () => Date
}

export const nowOf = (deps: SpreadsheetServiceDeps): Date => (deps.now ? deps.now() : new Date())

export type SpreadsheetBatchRow = {
  id: string
  pageId: string
  seq: bigint
  baseSeq: bigint
  clientOpId: string
  actorType: 'user' | 'agent'
  actorId: string
  agentId: string | null
  runId: string | null
  engineVersion: string
  diffs: Uint8Array
  structuralKind: string | null
  sheetIndexes: number[]
  cellCount: number
  summary: unknown
  createdAt: Date
}

/**
 * The wire form of a journal row. `displayName` is resolved by the caller when
 * it has a name to give; the fallback keeps a batch renderable rather than
 * failing a whole catch-up page over one deleted account.
 */
const STRUCTURAL_INTENT_KINDS: ReadonlySet<SpreadsheetIntent['kind']> = new Set([
  'insertRows',
  'deleteRows',
  'insertColumns',
  'deleteColumns',
  'moveRows',
  'moveColumns',
])

/**
 * The row/column intents a stored batch performed, for a client that has to
 * rebase its own refused batch over it.
 *
 * Only the structural ones travel. The rest of a summary is the writer's
 * private record — a cell's text, a style path — and a peer has the diffs for
 * those anyway; shipping them would put one person's keystrokes on everybody
 * else's wire for no gain. A summary that will not parse yields nothing, which
 * the client reads as "cannot be rebased" and refuses to replay blind.
 */
const structuralIntentsOf = (
  row: SpreadsheetBatchRow,
): { structuralIntents?: SpreadsheetIntent[] } => {
  if (!row.structuralKind) return {}
  const parsed = SpreadsheetBatchSummarySchema.safeParse(row.summary)
  if (!parsed.success) return {}
  const intents = (parsed.data.intents ?? []).filter((intent) =>
    STRUCTURAL_INTENT_KINDS.has(intent.kind))
  return intents.length > 0 ? { structuralIntents: intents } : {}
}

export const toAppliedBatch = (
  row: SpreadsheetBatchRow,
  options: { displayName?: string; includeDiffs?: boolean } = {},
): SpreadsheetAppliedBatch => ({
  ...structuralIntentsOf(row),
  batchId: row.id,
  pageId: row.pageId,
  seq: Number(row.seq),
  baseSeq: Number(row.baseSeq),
  clientOpId: row.clientOpId,
  actor: toSpreadsheetActor({
    type: row.actorType,
    id: row.actorId,
    displayName: options.displayName ?? (row.actorType === 'agent' ? 'Agent' : 'Someone'),
    agentId: row.agentId,
    runId: row.runId,
  }),
  engineVersion: row.engineVersion,
  diffs:
    options.includeDiffs === false
      ? null
      : Buffer.from(row.diffs).toString('base64'),
  structuralKind: (row.structuralKind ?? null) as SpreadsheetAppliedBatch['structuralKind'],
  sheetIndexes: row.sheetIndexes,
  cellCount: row.cellCount,
  createdAt: row.createdAt.toISOString(),
})
