import type { Prisma, PrismaClient } from '@prisma/client'
import { canReadSpace, createNativeKnowledgeProvider, loadSpaceViewer } from '@nessie/knowledge'
import { resolveLiveEntitlements } from '@nessie/runtime'
import {
  DocumentChangedStoredConfigSchema,
  DocumentChangedTriggerConfigSchema,
  type UoaSessionIdentity,
} from '@nessie/schemas'

import {
  refusalsFromZodError,
  TriggerConfigRefusalError,
  type TriggerConfigRefusal,
} from './trigger-config-refusal.js'
import { resolveTriggerTargetChannel, type TriggerTargetChannel } from './trigger-target-channel.js'

/**
 * A `document_changed` trigger's configuration, resolved on the server
 * (docs/plans/2026-09-23-ticket-driven-agents/triggers.md, "`document_changed`";
 * docs/standards/document-triggers.md).
 *
 * The project comes from the target channel; the space is always stored by
 * id — named, or the space of the folder or pages named, or else the
 * project's Documents space. Three reads decide whether the agent may watch
 * it, each refused on its field:
 *
 * - the space is readable by **the whole audience of the target channel** —
 *   project- or organisation-wide, never private, members-only, restricted,
 *   private to an agent or an agent's own home — because every change is
 *   reviewed in that channel;
 * - **the agent** can read it, with its own reach (a document wake runs with
 *   no effective user);
 * - **the person setting it up** can read it, asked of their live
 *   entitlement: nobody arms an agent on documents they could not open.
 */

export type DocumentTriggerResolveInput = {
  agent: { id: string; name: string; organizationId: string }
  /** The client config, server-owned keys already stripped. */
  config: Record<string, unknown>
  /**
   * The person creating or editing it, asked whether they can read the space.
   * Absent only on a resume, which switches back on what someone already set up.
   */
  author: { userId: string; uoaIdentity?: UoaSessionIdentity } | null
  nextRunAt?: string | null
  targetChannelId?: string | null
  targetThreadId?: string | null
}

export type DocumentTriggerResolution = {
  /** The stored config (`DocumentChangedStoredConfigSchema`), instructions included. */
  config: Record<string, unknown>
  scopeProjectId: string
  targetChannelId: string
}

const DOCUMENT_CHANNEL_WORDING = {
  missing: 'a document trigger needs the channel the agent reviews changes in: a public channel of the '
    + 'documents\' project that the agent is bound to',
  subject: 'a document trigger',
  whyPublic: 'everyone in the project can open the thread a change is reviewed in',
}

/** Audiences at least as wide as a public project channel's. */
const CHANNEL_WIDE_VISIBILITIES = new Set(['project', 'organization'])

const refuse = (path: string, reason: string): never => {
  throw new TriggerConfigRefusalError([{ path, reason }])
}

type Space = {
  id: string
  name: string
  projectId: string
  visibility: string
  sensitivityTier: string
  privateToAgentId: string | null
  ownerAgentId: string | null
}

const spaceSelect = {
  id: true,
  name: true,
  projectId: true,
  visibility: true,
  sensitivityTier: true,
  privateToAgentId: true,
  ownerAgentId: true,
} satisfies Prisma.KnowledgeSpaceSelect

type PageRef = { id: string; spaceId: string; kind: string; title: string }

const findPage = (prisma: PrismaClient, organizationId: string, pageId: string): Promise<PageRef | null> =>
  prisma.knowledgePage.findFirst({
    where: { id: pageId, organizationId, deletedAt: null, status: { not: 'archived' } },
    select: { id: true, spaceId: true, kind: true, title: true },
  })

/** The space named, or implied by the folder or pages named, or else the project's Documents space. */
const resolveSpace = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    channel: TriggerTargetChannel
    spaceId?: string
    folder: PageRef | null
    pages: PageRef[]
  },
): Promise<Space> => {
  const impliedId = input.spaceId ?? input.folder?.spaceId ?? input.pages[0]?.spaceId
  const space = impliedId
    ? await prisma.knowledgeSpace.findFirst({
        where: { id: impliedId, organizationId: input.organizationId, deletedAt: null },
        select: spaceSelect,
      })
    : await prisma.knowledgeSpace.findFirst({
        where: {
          organizationId: input.organizationId,
          projectId: input.channel.projectId,
          deletedAt: null,
          metadata: { path: ['projectDocuments'], equals: true },
        },
        select: spaceSelect,
      })
  if (!space) {
    return refuse(
      'spaceId',
      impliedId
        ? 'no such document space in this organisation'
        : `project ${input.channel.project.name} has no Documents space yet; name the space to watch`,
    )
  }
  if (space.projectId !== input.channel.projectId) {
    return refuse(
      'spaceId',
      `space ${space.name} is in another project than #${input.channel.label} (project `
      + `${input.channel.project.name}); a document trigger watches a space of its channel's project`,
    )
  }
  return space
}

/**
 * Every reader of the channel must be able to read what is reviewed there:
 * the reason a space is narrower than a public project channel, or null.
 * Asked at creation and again every time a change fires.
 */
export const documentSpaceAudienceRefusal = (
  space: Pick<Space, 'name' | 'visibility' | 'sensitivityTier' | 'privateToAgentId' | 'ownerAgentId'>,
  channel: Pick<TriggerTargetChannel, 'label'>,
): string | null => {
  if (space.sensitivityTier === 'restricted') {
    return `space ${space.name} holds restricted documents, which only people may read`
  }
  if (space.ownerAgentId || space.privateToAgentId) {
    return `space ${space.name} is an agent's own space; a document trigger watches a shared project space`
  }
  if (!CHANNEL_WIDE_VISIBILITIES.has(space.visibility)) {
    return `space ${space.name} is ${space.visibility}, narrower than #${channel.label}: every reader of the `
      + 'channel must be able to read the space, so a document trigger watches a project- or organisation-wide space'
  }
  return null
}

const spaceRecordFor = async (prisma: PrismaClient, organizationId: string, spaceId: string) => {
  const record = await createNativeKnowledgeProvider(prisma).getSpace(organizationId, spaceId)
  if (!record) return refuse('spaceId', 'no such document space in this organisation')
  return record
}

/**
 * Resolve and check a `document_changed` trigger's config, or throw
 * `TriggerConfigRefusalError` naming every field that is wrong.
 */
export const resolveDocumentChangedTrigger = async (
  prisma: PrismaClient,
  input: DocumentTriggerResolveInput,
): Promise<DocumentTriggerResolution> => {
  const refusals: TriggerConfigRefusal[] = []
  if (input.targetThreadId) {
    refusals.push({
      path: 'targetThreadId',
      reason: 'a document trigger opens one review thread per document in its channel; give targetChannelId only',
    })
  }
  if (input.nextRunAt) {
    refusals.push({ path: 'nextRunAt', reason: 'a document trigger runs when a document changes, not on a schedule' })
  }
  const parsed = DocumentChangedTriggerConfigSchema.safeParse(input.config)
  if (!parsed.success) refusals.push(...refusalsFromZodError(parsed.error))
  if (refusals.length > 0 || !parsed.success) throw new TriggerConfigRefusalError(refusals)
  const config = parsed.data
  const organizationId = input.agent.organizationId

  const channel = await resolveTriggerTargetChannel(prisma, {
    agent: input.agent,
    targetChannelId: input.targetChannelId,
    wording: DOCUMENT_CHANNEL_WORDING,
  })
  const folder = config.folderPageId ? await findPage(prisma, organizationId, config.folderPageId) : null
  if (config.folderPageId && (!folder || folder.kind !== 'folder')) {
    return refuse('folderPageId', folder ? `"${folder.title}" is a ${folder.kind}, not a folder` : 'no such folder')
  }
  const pages = await Promise.all((config.pageIds ?? []).map((pageId) => findPage(prisma, organizationId, pageId)))
  const space = await resolveSpace(prisma, {
    organizationId,
    channel,
    ...(config.spaceId ? { spaceId: config.spaceId } : {}),
    folder,
    pages: pages.filter((page): page is PageRef => page !== null),
  })
  if (folder && folder.spaceId !== space.id) {
    refusals.push({ path: 'folderPageId', reason: `folder "${folder.title}" is not in space ${space.name}` })
  }
  pages.forEach((page, index) => {
    const path = `pageIds[${index}]`
    if (!page) refusals.push({ path, reason: 'no such document' })
    else if (page.spaceId !== space.id) refusals.push({ path, reason: `"${page.title}" is not in space ${space.name}` })
    else if (!(config.kinds as readonly string[]).includes(page.kind)) {
      refusals.push({ path, reason: `"${page.title}" is a ${page.kind}, and this trigger watches ${config.kinds.join(' and ')} pages` })
    }
  })
  const audience = documentSpaceAudienceRefusal(space, channel)
  if (audience) refusals.push({ path: 'spaceId', reason: audience })
  if (refusals.length > 0) throw new TriggerConfigRefusalError(refusals)

  const record = await spaceRecordFor(prisma, organizationId, space.id)
  const agentViewer = await loadSpaceViewer(prisma, organizationId, { actorType: 'agent', actorId: input.agent.id })
  if (!canReadSpace(record, agentViewer)) {
    refusals.push({
      path: 'spaceId',
      reason: `${input.agent.name} cannot read space ${space.name}; bind it to a channel of the project, or share the space with it`,
    })
  }
  if (input.author) {
    const liveEntitlements = await resolveLiveEntitlements(prisma, {
      organizationId,
      userId: input.author.userId,
      ...(input.author.uoaIdentity ? { uoaIdentity: input.author.uoaIdentity } : {}),
    })
    const authorViewer = await loadSpaceViewer(
      prisma,
      organizationId,
      { actorType: 'user', actorId: input.author.userId },
      { liveEntitlements },
    )
    if (!canReadSpace(record, authorViewer)) {
      refusals.push({ path: 'spaceId', reason: `you cannot read space ${space.name}, so you cannot have an agent watch it` })
    }
  }
  if (refusals.length > 0) throw new TriggerConfigRefusalError(refusals)

  return {
    config: {
      spaceId: space.id,
      folderPageId: folder?.id ?? null,
      pageIds: config.pageIds ?? null,
      labels: config.labels ?? null,
      kinds: config.kinds,
      fireOn: config.fireOn,
      quietSeconds: config.quietSeconds,
      includeAgentEdits: config.includeAgentEdits,
      instructions: config.instructions,
    },
    scopeProjectId: channel.projectId,
    targetChannelId: channel.id,
  }
}

/**
 * A stored config written back in the typed input's words, so an edit can
 * change one key and have the rest resolved again as they were. A config that
 * no longer parses keeps nothing, and the edit then has to give every key.
 */
export const documentChangedConfigAsInput = (stored: unknown): Record<string, unknown> => {
  const parsed = DocumentChangedStoredConfigSchema.safeParse(stored)
  if (!parsed.success) return {}
  const { folderPageId, instructions, labels, pageIds } = parsed.data
  const { fireOn, includeAgentEdits, kinds, quietSeconds, spaceId } = parsed.data
  return {
    spaceId,
    kinds,
    fireOn,
    quietSeconds,
    includeAgentEdits,
    ...(folderPageId ? { folderPageId } : {}),
    ...(pageIds ? { pageIds } : {}),
    ...(labels ? { labels } : {}),
    ...(instructions ? { instructions } : {}),
  }
}

/**
 * An edit's config patch over the stored config in the input's words: a key
 * replaces, `instructions` merges one level deep, and `null` clears a
 * narrowing (`folderPageId`, `pageIds`, `labels`).
 */
export const mergeDocumentConfigPatch = (
  stored: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> => {
  const merged: Record<string, unknown> = { ...stored, ...patch }
  const before = stored['instructions']
  const next = patch['instructions']
  if (before && typeof before === 'object' && next && typeof next === 'object' && !Array.isArray(next)) {
    merged['instructions'] = { ...before as Record<string, unknown>, ...next as Record<string, unknown> }
  }
  for (const key of ['folderPageId', 'pageIds', 'labels'] as const) {
    if (merged[key] === null) delete merged[key]
  }
  return merged
}

/**
 * Why a stored `document_changed` trigger may not be switched back on without
 * an edit, or null when it may: its stored config resolved exactly as a
 * create would, except for the author's own read (a resume sets nothing up).
 */
export const documentTriggerResumeRefusal = async (
  prisma: PrismaClient,
  trigger: {
    agent: { id: string; name: string; organizationId: string | null } | null
    config: unknown
    targetChannelId: string | null
  },
): Promise<string | null> => {
  const agent = trigger.agent
  if (!agent?.organizationId) return 'This document trigger\'s agent is gone, so it cannot be resumed.'
  try {
    await resolveDocumentChangedTrigger(prisma, {
      agent: { id: agent.id, name: agent.name, organizationId: agent.organizationId },
      author: null,
      config: documentChangedConfigAsInput(trigger.config),
      targetChannelId: trigger.targetChannelId,
    })
    return null
  } catch (error) {
    if (!(error instanceof TriggerConfigRefusalError)) throw error
    return `Edit this document trigger before resuming it — ${
      error.refusals.map((refusal) => `${refusal.path}: ${refusal.reason}`).join('; ')}.`
  }
}
