import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'

import type { Prisma, PrismaClient } from '@prisma/client'
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
  type DeepWaterBriefRun,
  type FileService,
  type LedgerAttribution,
} from '@nessie/runtime'
import {
  KNOWLEDGE_EMBED_TOPIC,
  deepWaterArtifactFileName,
  type DeepWaterArtifactKind,
  type KnowledgeInferenceOrigin,
  type LedgerResearchReference,
  type LedgerResearchReport,
} from '@nessie/schemas'
import { documentTriggerOnVersionCreated } from '@nessie/team-admin'

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
 *
 * Each is stored under the name it downloads as (`deepWaterArtifactFileName`,
 * the one function the admin names its downloads with too), from the title
 * and report kind the run shows once delivered — the delivery claim keeps
 * Ledger's title when it has one — so a signed-URL download and a proxied one
 * carry the same name as the button that started it.
 */
export const storeDeepWaterArtifacts = async (
  deps: DeepWaterImportDeps,
  run: DeepWaterBriefRun,
  input: { report: LedgerResearchReport; projectId: string },
): Promise<{ reportFileId: string; sourcesFileId: string }> => {
  const attribution = deepWaterDeliveryAttribution(run)
  const named = {
    title: input.report.title ?? run.title,
    topic: run.input?.topic ?? run.queryPreview,
    reportKind: input.report.reportKind,
  }
  const files: Record<DeepWaterArtifactKind, { filename: string; mime: string; body: string }> = {
    report: {
      filename: deepWaterArtifactFileName(named, 'report'),
      mime: 'text/markdown',
      body: input.report.reportMarkdown,
    },
    sources: {
      filename: deepWaterArtifactFileName(named, 'sources'),
      mime: 'text/csv',
      body: deepWaterSourcesCsv(input.report.references),
    },
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

type ReportPageRow = { deletedAt: Date | null; status: string; metadata: unknown }

/**
 * Is the run's page still its report page? Deleting a page in Documents
 * archives it (the Knowledge delete route), so an archived page counts as
 * deleted, as it does for every Knowledge read; and its marker must still name
 * this run and its stored report.
 */
const reportPageProblem = (page: ReportPageRow, runId: string, reportFileId: string): 'deleted' | 'changed' | null => {
  if (page.deletedAt !== null || page.status === 'archived') return 'deleted'
  const marker = (page.metadata as PageMetadata)?.deepWaterReport
  return marker?.runId === runId && marker.reportFileId === reportFileId ? null : 'changed'
}

/**
 * A person's Retry import puts the run's own report page back. Its id is fixed
 * by the run, so a page deleted (or re-labelled) in Documents before the
 * result was shared can never be created again, and without this every retry
 * would block on it for good. Only that page is touched — undeleted, and its
 * marker rewritten to the run's stored report, which is what the page was made
 * from — and only for an undelivered run whose report is stored. True when it
 * restored something.
 */
export const restoreDeepWaterReportPage = async (
  prisma: PrismaClient,
  run: DeepWaterBriefRun,
): Promise<boolean> => {
  if (run.deliveredAt !== null || run.reportFileId === null) return false
  const pageId = deepWaterReportPageId(run.organizationId, run.id)
  const page = await prisma.knowledgePage.findFirst({
    where: { id: pageId, organizationId: run.organizationId },
    select: { deletedAt: true, status: true, metadata: true },
  })
  if (!page) return false
  const problem = reportPageProblem(page, run.id, run.reportFileId)
  if (!problem) return false
  const metadata = page.metadata && typeof page.metadata === 'object' && !Array.isArray(page.metadata)
    ? page.metadata as Record<string, unknown>
    : {}
  await prisma.knowledgePage.update({
    where: { id: pageId },
    data: {
      deletedAt: null,
      // Created as a draft, which is what an archive took it from.
      ...(page.status === 'archived' ? { status: 'draft' as const } : {}),
      metadata: {
        ...metadata,
        deepWaterReport: { runId: run.id, reportFileId: run.reportFileId },
      } as Prisma.InputJsonValue,
    },
  })
  console.info(`[deep-water] run ${run.id}: Retry import restored its report page (${problem})`)
  return true
}

/**
 * Ensure the run's report page: create it once with a fixed id, or accept the
 * page an earlier attempt created — wherever a person has since moved it —
 * only while it is still the page for this run and this stored report. A page
 * that was deleted or changed blocks delivery; it is never overwritten here
 * (`restoreDeepWaterReportPage` puts it back on the person's Retry).
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
      select: { deletedAt: true, status: true, metadata: true, spaceId: true },
    })
    if (!existing) return null
    const problem = reportPageProblem(existing, run.id, input.reportFileId)
    if (problem === null) return { kind: 'ok' as const, pageId, spaceId: existing.spaceId }
    console.warn(`[deep-water] run ${run.id}: its report page was ${problem} before delivery; Retry import restores it`)
    return { kind: 'blocked' as const }
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
    // A report landing in a watched space is a new document there, like any other.
    onVersionCreated: documentTriggerOnVersionCreated,
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
