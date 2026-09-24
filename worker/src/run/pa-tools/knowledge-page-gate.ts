import type { Prisma } from '@prisma/client'
import {
  canReadKnowledgePageVersion,
  canReadSpace,
  createNativeKnowledgeProvider,
  htmlToPlainText,
  isMarkdownAttachment,
  loadSpaceViewer,
  type KnowledgePageRecord,
  type KnowledgeSpaceRecord,
  type SpaceViewer,
} from '@nessie/knowledge'
import { resolveDisclosureViewer, resolveLiveEntitlements, type DisclosureViewer } from '@nessie/runtime'

import { fileServiceFor } from '../file-service.js'
import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import { buildSpaceViewerPrincipal, resolveEffectiveUserId } from './access.js'
import { readMarkdownAttachmentContent } from './knowledge-document-io.js'

/**
 * The gates every tool that hands a page's text to a model passes, in one
 * place: `kb_page_read` and `kb_page_diff` alike. The page and its space must
 * exist in this organisation; the caller must read the space; an agent never
 * reads a page that is restricted or private to another agent, even inside a
 * space it may read; and each version read must pass its own disclosure basis
 * for this viewer. Only after all of that is anything recorded in the run's
 * consumed-source sink or read from storage.
 */

export const ACCESS_DENIED_MESSAGE = 'You do not have access to this knowledge page.'

export type KnowledgeAccessViewers = {
  disclosureViewer: DisclosureViewer
  viewer: SpaceViewer
}

// One fresh human UOA proof governs both ordinary KB home access and version
// disclosure. A tool reuses this pair through all of its reads and mutations;
// resolving either side per page would be both slower and an authority split.
export const resolveKnowledgeAccessViewers = async (
  context: BuiltinToolRuntimeContext,
): Promise<KnowledgeAccessViewers> => {
  const organizationId = String(context.channel.organizationId)
  const effectiveUserId = resolveEffectiveUserId(context)
  const liveEntitlements = effectiveUserId
    ? await resolveLiveEntitlements(context.prisma, {
        organizationId,
        userId: effectiveUserId,
        uoaIdentity: context.actorContext.actionContext.uoaIdentity,
      })
    : undefined
  const disclosureViewer = await resolveDisclosureViewer(
    context.prisma,
    organizationId,
    effectiveUserId,
    effectiveUserId
      ? { liveEntitlements }
      : { agentId: context.agentId },
  )
  const viewer = await loadSpaceViewer(
    context.prisma,
    organizationId,
    buildSpaceViewerPrincipal(context),
    liveEntitlements ? { liveEntitlements, effectiveUserId } : {},
  )
  return { disclosureViewer, viewer }
}

export type ReadablePage = {
  page: KnowledgePageRecord
  space: KnowledgeSpaceRecord
  disclosureViewer: DisclosureViewer
}

export type PageGateRefusal = { refused: string }

export const openReadablePage = async (
  context: BuiltinToolRuntimeContext,
  pageId: string,
): Promise<ReadablePage | PageGateRefusal> => {
  const organizationId = String(context.channel.organizationId)
  const provider = createNativeKnowledgeProvider(context.prisma)
  const page = await provider.getPage(organizationId, pageId)
  if (!page) return { refused: `Knowledge page not found: ${pageId}` }
  const space = await provider.getSpace(organizationId, page.spaceId)
  if (!space) return { refused: `Knowledge space not found for page: ${pageId}` }

  const principal = buildSpaceViewerPrincipal(context)
  const { disclosureViewer, viewer } = await resolveKnowledgeAccessViewers(context)
  if (!canReadSpace(space, viewer)) return { refused: ACCESS_DENIED_MESSAGE }
  // Page-level privacy beyond the space: an agent viewer never sees a page
  // that is itself restricted or privately scoped to a different agent, even
  // when the containing space is otherwise readable.
  if (principal.actorType === 'agent') {
    const deniedByTier = page.sensitivityTier === 'restricted'
    const deniedByPrivacy = page.privateToAgentId !== null && page.privateToAgentId !== principal.actorId
    if (deniedByTier || deniedByPrivacy) return { refused: ACCESS_DENIED_MESSAGE }
  }
  return { page, space, disclosureViewer }
}

const VERSION_SELECT = {
  attachmentId: true,
  basisScopes: { select: { scopeId: true, scopeType: true } },
  body: true,
  disclosureSources: { select: { sourceAuthorUserId: true, sourceChannelId: true } },
  id: true,
  versionNumber: true,
  authorType: true,
  createdAt: true,
} satisfies Prisma.KnowledgePageVersionSelect

export type ReadableVersion = Prisma.KnowledgePageVersionGetPayload<{ select: typeof VERSION_SELECT }>

/** One version of an opened page, if it is this page's and its own disclosure basis admits the viewer. */
export const loadReadableVersion = async (
  context: BuiltinToolRuntimeContext,
  readable: ReadablePage,
  versionId: string,
): Promise<ReadableVersion | PageGateRefusal> => {
  const version = await context.prisma.knowledgePageVersion.findFirst({
    where: {
      id: versionId,
      pageId: readable.page.id,
      page: { deletedAt: null, organizationId: String(context.channel.organizationId) },
    },
    select: VERSION_SELECT,
  })
  if (!version) return { refused: `Knowledge page version not found: ${versionId}` }
  if (!canReadKnowledgePageVersion(version, readable.disclosureViewer)) return { refused: ACCESS_DENIED_MESSAGE }
  return version
}

export type PageReadDependencies = { files?: Parameters<typeof readMarkdownAttachmentContent>[0] }

/**
 * A version as the plain text a model reads: a Markdown file's own bytes
 * through FileService, a rich-text body as plain text, or — for a file with no
 * extracted text — a sentence saying so. Call only after the version passed
 * `loadReadableVersion` and was recorded in the sink.
 */
export const versionPlainText = async (
  context: BuiltinToolRuntimeContext,
  version: Pick<ReadableVersion, 'attachmentId' | 'body'>,
  dependencies: PageReadDependencies = {},
): Promise<string> => {
  const organizationId = String(context.channel.organizationId)
  const attachment = version.attachmentId
    ? await context.prisma.attachment.findUnique({
        where: { id: version.attachmentId },
        select: { filename: true, mime: true, organizationId: true },
      })
    : null
  const isCanonicalMarkdown = attachment
    && attachment.organizationId === organizationId
    && isMarkdownAttachment(attachment)
  if (isCanonicalMarkdown) {
    const markdown = await readMarkdownAttachmentContent(
      dependencies.files ?? fileServiceFor(context.prisma),
      version.attachmentId ?? '',
      organizationId,
    )
    return markdown ?? '(Markdown attachment bytes are unavailable.)'
  }
  if (version.body === null && attachment) {
    return `No extracted text is available for ${attachment.filename} (${attachment.mime}). `
      + 'Use its file-specific tool when available, or ask a person to provide a text-readable version.'
  }
  return htmlToPlainText(version.body ?? '')
}
