import { enqueueQueueJob, writeAuditEntryInTransaction } from '@nessie/db'
import {
  SpreadsheetServiceError,
  createSpreadsheetService,
  publishSpreadsheetPresenceLeave,
  type SpreadsheetServiceDeps,
  type SpreadsheetWriteActor,
} from '@nessie/knowledge'
import { attributionFromActorContext } from '@nessie/runtime'
import { SPREADSHEET_LIMITS, type AuditAction, type AuthorizedActionContext } from '@nessie/schemas'
import type { FastifyReply } from 'fastify'

import { sendApiError } from '../lib/api.js'
import { createKnowledgeAccess, type KnowledgeRouteDeps } from './knowledge-base-access.js'

/**
 * The compaction topic. Declared beside its publisher;
 * `worker/src/control/spreadsheet-compact.ts` is its only consumer, and the
 * two constants are asserted equal in `api/test/spreadsheet-io.test.ts`.
 */
export const SPREADSHEET_COMPACT_TOPIC = 'spreadsheet.compact'

/**
 * Everything the three spreadsheet route modules share, built **once per
 * process**: the model cache and the presence budget are closure state of
 * `createSpreadsheetService`, so building this per request (or per route
 * module) would give each of them their own cache and defeat the point.
 */
export type SpreadsheetRouteContext = {
  service: ReturnType<typeof createSpreadsheetService>
  access: ReturnType<typeof createKnowledgeAccess>
}

export const createSpreadsheetRouteContext = (
  deps: KnowledgeRouteDeps,
): SpreadsheetRouteContext => {
  const access = createKnowledgeAccess(deps)
  const service = createSpreadsheetService({
    prisma: deps.prisma,
    fileService: deps.fileService,
    createPage: (input) => access.provider.createPage(input),
    addFileVersion: (input) => access.provider.addFileVersion(input),
    // Each process publishes through its own transport; the worker hands in
    // its own, and a test hands in a recorder.
    publish: async (event, input) => {
      await deps.realtimeHub.publishDocumentEphemeral(
        input.pageId,
        input.organizationId,
        event,
        input.data,
      )
    },
    // Housekeeping, enqueued after the batch committed. The key is per page
    // and per cadence step, so two replicas crossing the threshold in the same
    // second enqueue one job rather than two xlsx writes.
    enqueueCompaction: async (input) => {
      await enqueueQueueJob(deps.prisma, {
        idempotencyKey: `sheet-compact:${input.pageId}:${Math.floor(
          input.seq / SPREADSHEET_LIMITS.compactEveryBatches,
        )}`,
        topic: SPREADSHEET_COMPACT_TOPIC,
        payload: {
          organizationId: input.organizationId,
          pageId: input.pageId,
          seq: input.seq,
        },
      })
    },
    // Written inside the batch's own transaction, so a batch that rolled back
    // never leaves an audit row claiming it landed.
    writeAudit: async (tx, entry) => {
      await writeAuditEntryInTransaction(tx, {
        organizationId: entry.organizationId,
        projectId: entry.projectId,
        teamId: entry.teamId,
        actorType: entry.actorType,
        actorId: entry.actorId,
        action: entry.action as AuditAction,
        resourceType: 'knowledge_page',
        resourceId: entry.resourceId,
        outcome: 'success',
        metadata: entry.metadata as Record<string, never>,
        requestId: `spreadsheet:${entry.resourceId}`,
      })
    },
  })
  return { service, access }
}

export type SpreadsheetDeps = SpreadsheetServiceDeps

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const runIdOf = (actorContext: AuthorizedActionContext): { runId?: string } => {
  const candidate = actorContext.actionContext.correlationId
  return candidate && UUID.test(candidate) ? { runId: candidate } : {}
}

/** The actor a batch is written as, and the display name presence stamps. */
export const spreadsheetActorFor = async (
  deps: KnowledgeRouteDeps,
  actorContext: AuthorizedActionContext,
): Promise<SpreadsheetWriteActor> => {
  const { actorType, actorId } = actorContext.actor
  if (actorType === 'agent') {
    const agent = await deps.prisma.agent.findFirst({
      where: { id: actorId, organizationId: actorContext.tenant.organizationId },
      select: { id: true, name: true },
    })
    return {
      type: 'agent',
      id: actorId,
      displayName: agent?.name ?? 'Agent',
      agentId: actorId,
      // `correlationId` is the run a tool call is running under; there is no
      // dedicated run field on the action context, and the run is what the
      // "before: <agent> started editing" version keys off. It is only ever a
      // run when it is a uuid — `run_id` is a UUID column and a correlation id
      // set by something else would fail the insert rather than the check.
      ...(runIdOf(actorContext)),
      ...(actorContext.actionContext.agentCredentialId
        ? { agentCredentialId: actorContext.actionContext.agentCredentialId }
        : {}),
    }
  }
  const user = await deps.prisma.user.findUnique({
    where: { id: actorId },
    select: { displayName: true },
  })
  return { type: 'user', id: actorId, displayName: user?.displayName ?? 'Someone' }
}

export const spreadsheetAttribution = attributionFromActorContext

/**
 * One mapping from the service's failure vocabulary to a response, so a new
 * route cannot invent a different status for the same refusal. Anything that
 * is not a `SpreadsheetServiceError` is re-thrown for the framework's own
 * handler — a bug should not be flattened into a 400.
 */
export const sendSpreadsheetError = (reply: FastifyReply, error: unknown): FastifyReply => {
  if (!(error instanceof SpreadsheetServiceError)) throw error
  return sendApiError(
    reply,
    error.statusCode,
    error.code,
    error.message,
    undefined,
    error.details,
  )
}

/**
 * A pane that went away. Fire-and-forget: presence is ephemeral, and a lost
 * `leave` only means peers wait out the 30 s expiry instead of seeing the
 * avatar disappear at once. Never let it reject into a socket close handler.
 */
export const publishLeaveOnClose = async (
  service: SpreadsheetServiceDeps,
  input: { organizationId: string; pageId: string; clientId: string },
): Promise<void> => {
  try {
    await publishSpreadsheetPresenceLeave(service, input)
  } catch {
    // The replica is shutting down or the page is gone; nothing to recover.
  }
}
