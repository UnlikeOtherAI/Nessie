import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'

import type { PrismaClient } from '@prisma/client'
import { enqueueQueueJob } from '@nessie/db'
import {
  createNativeKnowledgeProvider,
  ensureMyDocsSpace,
  ensureProjectDocumentsSpace,
  knowledgeEmbeddingJobKey,
} from '@nessie/knowledge'
import {
  completeLedgerAttribution,
  recordDeepWaterArtifactFile,
  type DeepWaterArtifactKind,
  type DeepWaterBriefRun,
  type FileService,
  type LedgerAttribution,
} from '@nessie/runtime'
import {
  KNOWLEDGE_EMBED_TOPIC,
  type KnowledgeInferenceOrigin,
  type LedgerResearchReference,
  type LedgerResearchReport,
} from '@nessie/schemas'

/**
 * The steps of a delivery that are safe to repeat (Water plan amendments N3
 * A, C11): storing the exact report and its sources as the run's artifacts,
 * and importing the report into Documents on a page whose id is fixed by the
 * run. Each records or verifies its receipt, so a repeat adopts what the first
 * attempt made instead of making a second one.
 */

export type DeepWaterImportDeps = {
  prisma: PrismaClient
  fileService: Pick<FileService, 'store' | 'delete' | 'openStream'>
  /** Keys the page's embedding job, as every other knowledge writer does. */
  embeddingModel: string | null
}

const DELIVERY_COMPONENT = 'deep-water.delivery'

const formatUuid = (seed: string): string => {
  const hex = createHash('sha256').update(seed).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** The one Documents page a run's report is imported to. */
export const deepWaterReportPageId = (organizationId: string, runId: string): string =>
  formatUuid(`nessie:deep-water:report:${organizationId}:${runId}`)

/** Delivery's own attribution: storage accounting and embeddings, for the requester. */
export const deepWaterDeliveryAttribution = (run: DeepWaterBriefRun): LedgerAttribution => {
  if (!run.requestedByUserId) throw new Error(`DeepWater run ${run.id} has no requester`)
  return completeLedgerAttribution({
    organizationId: run.organizationId,
    teamId: run.teamId,
    userId: run.requestedByUserId,
    runId: run.id,
    systemComponent: DELIVERY_COMPONENT,
    actorId: run.requestedByUserId,
    actorType: 'system',
    ...(run.uoaIdentity ? { uoaIdentity: run.uoaIdentity } : {}),
  })
}

const csvField = (value: string): string =>
  /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value

/** `sources.csv`: one row per reference, RFC 4180. */
export const deepWaterSourcesCsv = (references: readonly LedgerResearchReference[]): string =>
  ['title,url,accessed_at', ...references.map((reference) =>
    [reference.title, reference.url, reference.accessedAt].map(csvField).join(','))]
    .join('\r\n') + '\r\n'

const fileSlug = (title: string): string =>
  title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'research'

const RUN_COLUMN: Record<DeepWaterArtifactKind, 'reportFileId' | 'sourcesFileId'> = {
  report: 'reportFileId',
  sources: 'sourcesFileId',
}

/**
 * Store `report.md` (the exact markdown Ledger returned) and `sources.csv`,
 * each once. A store that loses the receipt race deletes its own copy and uses
 * the winner's. A crash between the store and the receipt leaves one orphan
 * attachment — the residual task-set artifacts accept for the same reason: a
 * receipt cannot be written in the object store's transaction.
 */
export const storeDeepWaterArtifacts = async (
  deps: DeepWaterImportDeps,
  run: DeepWaterBriefRun,
  input: { report: LedgerResearchReport; title: string; projectId: string },
): Promise<{ reportFileId: string; sourcesFileId: string }> => {
  const attribution = deepWaterDeliveryAttribution(run)
  const slug = fileSlug(input.title)
  const files: Record<DeepWaterArtifactKind, { filename: string; mime: string; body: string }> = {
    report: {
      filename: input.report.reportKind === 'summary' ? `${slug}-summary.md` : `${slug}.md`,
      mime: 'text/markdown',
      body: input.report.reportMarkdown,
    },
    sources: { filename: `${slug}-sources.csv`, mime: 'text/csv', body: deepWaterSourcesCsv(input.report.references) },
  }
  const stored: Partial<Record<DeepWaterArtifactKind, string>> = {}
  for (const kind of ['report', 'sources'] as const) {
    const existing = run[RUN_COLUMN[kind]]
    if (existing) {
      stored[kind] = existing
      continue
    }
    const file = files[kind]
    const { attachment } = await deps.fileService.store({
      attribution,
      organizationId: run.organizationId,
      uploaderId: null,
      filename: file.filename,
      mime: file.mime,
      body: Readable.from(Buffer.from(file.body, 'utf8')),
      scope: { projectId: input.projectId, teamId: run.teamId },
    })
    const receipt = await deps.prisma.$transaction((tx) => recordDeepWaterArtifactFile(tx, {
      organizationId: run.organizationId,
      runId: run.id,
      kind,
      attachmentId: attachment.id,
    }))
    if (!receipt.stored) {
      await deps.fileService.delete(attachment.id, run.organizationId, attribution)
    }
    stored[kind] = receipt.attachmentId
  }
  if (!stored.report || !stored.sources) throw new Error(`DeepWater run ${run.id} artifacts were not stored`)
  return { reportFileId: stored.report, sourcesFileId: stored.sources }
}

export type DeepWaterReportDestination = { spaceId: string; projectId: string }

/**
 * Where the report goes: the requester's My Docs for a direct message or a
 * Personal Assistant conversation, otherwise the origin project's Project
 * Documents. Null when the origin thread is gone.
 */
export const resolveDeepWaterReportDestination = async (
  prisma: PrismaClient,
  run: DeepWaterBriefRun,
): Promise<DeepWaterReportDestination | null> => {
  if (!run.threadId || !run.requestedByUserId) return null
  const thread = await prisma.thread.findFirst({
    where: { id: run.threadId, channel: { organizationId: run.organizationId, deletedAt: null } },
    select: { channel: { select: { projectId: true, type: true, systemChannelType: true } } },
  })
  if (!thread) return null
  const { projectId } = thread.channel
  const personal = thread.channel.type === 'dm' || thread.channel.systemChannelType === 'personal_assistant'
  const space = personal
    ? await ensureMyDocsSpace(prisma, { organizationId: run.organizationId, projectId, userId: run.requestedByUserId })
    : await ensureProjectDocumentsSpace(prisma, {
        organizationId: run.organizationId,
        projectId,
        actorId: run.requestedByUserId,
      })
  return { spaceId: space.spaceId, projectId }
}

const reportNotes = (report: LedgerResearchReport): string[] => [
  ...(report.reportKind === 'summary'
    ? ['DeepWater could not write the full report for this research. This page holds the research summary.']
    : []),
  ...(report.truncated
    ? ['This report was longer than DeepWater can hand over in one piece, so its end is missing.']
    : []),
]

type PageMetadata = { deepWaterReport?: { runId?: unknown; reportFileId?: unknown } } | null

/**
 * Ensure the run's report page: create it once with a fixed id, or accept the
 * page an earlier attempt created — wherever a person has since moved it —
 * only while it is still the page for this run and this stored report. A page
 * that was deleted or replaced blocks delivery; it is never overwritten.
 */
export const ensureDeepWaterReportPage = async (
  deps: DeepWaterImportDeps,
  run: DeepWaterBriefRun,
  input: {
    destination: DeepWaterReportDestination
    reportFileId: string
    report: LedgerResearchReport
    title: string
  },
): Promise<{ kind: 'ok'; pageId: string; spaceId: string } | { kind: 'blocked' }> => {
  const pageId = deepWaterReportPageId(run.organizationId, run.id)
  const verify = async () => {
    const existing = await deps.prisma.knowledgePage.findFirst({
      where: { id: pageId, organizationId: run.organizationId },
      select: { deletedAt: true, metadata: true, spaceId: true },
    })
    if (!existing) return null
    const marker = (existing.metadata as PageMetadata)?.deepWaterReport
    return !existing.deletedAt && marker?.runId === run.id && marker.reportFileId === input.reportFileId
      ? { kind: 'ok' as const, pageId, spaceId: existing.spaceId }
      : { kind: 'blocked' as const }
  }
  const found = await verify()
  if (found) return found
  if (!run.requestedByUserId) return { kind: 'blocked' }

  const attribution = deepWaterDeliveryAttribution(run)
  const origin: KnowledgeInferenceOrigin = {
    userId: run.requestedByUserId,
    teamId: run.teamId,
    agentId: attribution.agentId as string,
    runId: run.id,
    actorId: run.requestedByUserId,
    actorType: 'system',
    requestId: `${DELIVERY_COMPONENT}:${run.id}`,
    systemComponent: DELIVERY_COMPONENT,
    ...(run.uoaIdentity ? { uoaIdentity: run.uoaIdentity } : {}),
  }
  const provider = createNativeKnowledgeProvider(deps.prisma, {
    readMarkdownAttachment: async (attachmentId, organizationId) =>
      (await deps.fileService.openStream(attachmentId, organizationId))?.stream ?? null,
    // Embedded like every other version, on the requester's attribution.
    onVersionChunksReplaced: async (tx, event) => {
      await enqueueQueueJob(tx, {
        idempotencyKey: knowledgeEmbeddingJobKey(event.pageId, event.versionId, deps.embeddingModel ?? 'unresolved'),
        payload: { ...event, origin: { ...origin, requestId: `${DELIVERY_COMPONENT}:${event.versionId}` } },
        topic: KNOWLEDGE_EMBED_TOPIC,
      })
    },
  })
  const notes = reportNotes(input.report).map((note) => `> ${note}`)
  try {
    const page = await provider.createPage({
      id: pageId,
      organizationId: run.organizationId,
      projectId: input.destination.projectId,
      teamId: run.teamId,
      spaceId: input.destination.spaceId,
      title: input.title,
      body: [...notes, ...(notes.length > 0 ? [''] : []), input.report.reportMarkdown].join('\n'),
      origin: 'agent_authored',
      trust: 'unverified_import',
      labels: ['deep-water'],
      metadata: { deepWaterReport: { runId: run.id, reportFileId: input.reportFileId } },
      authorId: run.requestedByUserId,
      authorType: 'user',
      createdBy: run.requestedByUserId,
      basisScopes: run.sourceScopes,
      disclosureSources: run.disclosureSources,
    })
    return { kind: 'ok', pageId: page.id, spaceId: input.destination.spaceId }
  } catch (error) {
    // The fixed page id fences a concurrent attempt; re-verify its page.
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
      return (await verify()) ?? { kind: 'blocked' }
    }
    throw error
  }
}
