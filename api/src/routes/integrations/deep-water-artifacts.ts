import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  attributionFromActorContext,
  recordStorageTransferUsage,
  SIGNED_DOWNLOAD_MIN_BYTES,
  type DeepWaterBriefRun,
} from '@nessie/runtime'
import {
  DEEP_WATER_BRIEF_ERROR_CODES,
  DeepWaterReportArtifactResponseSchema,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../../lib/api.js'
import { readStreamCapped } from '../../lib/markdown.js'
import {
  loadVisibleDeepWaterRun,
  type DeepWaterRunAccessDeps,
} from '../../services/deepwater-research-run-access.js'
import type { RouteDeps } from '../types.js'
import { sendAttachmentDownload } from '../uploads.js'

/**
 * A finished research's artifacts (Water plan nessie.md §7.9): the exact
 * report markdown and the sources Ledger returned, stored once at delivery
 * through the `FileService`, and served here to whoever may see the research —
 * the run's viewer predicate, never the generic attachment route, which
 * refuses them (no uploader, never published). Download report, Download
 * sources and Copy markdown read these bytes; nothing re-renders the
 * Knowledge page.
 */

const ARTIFACTS_PATH = '/api/integrations/products/deep-water/research-runs/:runId/artifacts'

const RunParamsSchema = z.object({ runId: z.string().uuid() }).strict()

export type DeepWaterArtifactRouteDeps = RouteDeps & Pick<DeepWaterRunAccessDeps, 'resolveLiveEntitlements'>

type ArtifactKind = 'report' | 'sources'

/**
 * The stored artifact a delivered research offers. Before delivery the view
 * offers none (`artifacts: null`), so neither does this; a failed research is
 * delivered with none stored.
 */
const deliveredArtifactId = (run: DeepWaterBriefRun, kind: ArtifactKind): string | null => {
  if (run.deliveredAt === null) return null
  return kind === 'report' ? run.reportFileId : run.sourcesFileId
}

export const registerDeepWaterArtifactRoutes = (app: FastifyInstance, deps: DeepWaterArtifactRouteDeps): void => {
  const { fileService, prisma, requireActorContext, requireUserActor } = deps

  /** The visible run and its artifact id, or null once an error has been sent. */
  const resolveArtifact = async (
    request: FastifyRequest,
    reply: FastifyReply,
    kind: ArtifactKind,
  ): Promise<{ actorContext: AuthorizedActionContext; run: DeepWaterBriefRun; fileId: string } | null> => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return null
    if (!requireUserActor(actorContext, reply)) return null
    const params = parseInput(RunParamsSchema, request.params, reply, 'params')
    if (!params) return null
    if (!(actorContext.tenant.teamId ?? actorContext.actionContext.teamId)) {
      sendApiError(reply, 400, 'TEAM_CONTEXT_REQUIRED', 'A team context is required')
      return null
    }
    const run = await loadVisibleDeepWaterRun(deps, {
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
      uoaIdentity: actorContext.actionContext.uoaIdentity,
      runId: params.runId,
    })
    if (!run) {
      sendApiError(reply, 404, DEEP_WATER_BRIEF_ERROR_CODES.RESEARCH_NOT_FOUND, 'Research not found')
      return null
    }
    const fileId = deliveredArtifactId(run, kind)
    if (!fileId) {
      sendApiError(reply, 404, DEEP_WATER_BRIEF_ERROR_CODES.ARTIFACT_NOT_FOUND, 'This research has no such file')
      return null
    }
    return { actorContext, run, fileId }
  }

  /** A recorded artifact whose bytes are gone is a storage fault, never a state to hide. */
  const bytesMissing = (reply: FastifyReply, run: DeepWaterBriefRun, fileId: string) => {
    console.error(`[deep-water] run ${run.id}: stored artifact ${fileId} has no bytes`)
    return sendApiError(reply, 404, 'ATTACHMENT_BYTES_MISSING', 'The file is missing from storage')
  }

  const download = (kind: ArtifactKind) => async (request: FastifyRequest, reply: FastifyReply) => {
    const startedAt = Date.now()
    const resolved = await resolveArtifact(request, reply, kind)
    if (!resolved) return reply
    const { actorContext, run, fileId } = resolved
    const opened = await fileService.openDownload(fileId, run.organizationId)
    if (!opened) return bytesMissing(reply, run, fileId)
    // The stored filename is the slugged title (`<slug>.md`, `<slug>-summary.md`
    // for a summary, `<slug>-sources.csv`); markdown and CSV always download.
    return sendAttachmentDownload(request, reply, opened, {
      attribution: attributionFromActorContext(actorContext),
      prisma,
      source: `api.deep-water.artifacts.${kind}`,
      startedAt,
    })
  }

  app.get(`${ARTIFACTS_PATH}/report.md`, download('report'))
  app.get(`${ARTIFACTS_PATH}/sources.csv`, download('sources'))

  // Copy markdown: the same stored bytes, as text. They travel through the API
  // like a proxied download, so a report past the proxy budget is refused
  // rather than pinned to one process; Download report still serves it.
  app.get(`${ARTIFACTS_PATH}/report`, async (request, reply) => {
    const startedAt = Date.now()
    const resolved = await resolveArtifact(request, reply, 'report')
    if (!resolved) return reply
    const { actorContext, run, fileId } = resolved
    const opened = await fileService.openStream(fileId, run.organizationId)
    if (!opened) return bytesMissing(reply, run, fileId)
    const bytes = await readStreamCapped(opened.stream, SIGNED_DOWNLOAD_MIN_BYTES)
    if (!bytes) {
      return sendApiError(
        reply,
        413,
        DEEP_WATER_BRIEF_ERROR_CODES.REPORT_TOO_LARGE_TO_COPY,
        'This report is too long to copy here. Download it instead.',
      )
    }
    void recordStorageTransferUsage(prisma, {
      attribution: attributionFromActorContext(actorContext),
      bytes: bytes.length,
      latencyMs: Date.now() - startedAt,
      metadata: { attachmentId: fileId, delivery: 'proxy', source: 'api.deep-water.artifacts.copy' },
      operation: 'download',
    }).catch((error: unknown) => {
      console.error(`[deep-water] run ${run.id}: recording the copied report's transfer failed`, error)
    })
    reply.header('cache-control', 'private, no-store')
    return createApiResponse(DeepWaterReportArtifactResponseSchema.parse({
      markdown: bytes.toString('utf8'),
      truncated: run.reportTruncated,
      reportKind: run.reportKind,
    }))
  })
}
