import type { PrismaClient } from '@prisma/client'
import type { KnowledgeSpaceRecord } from '@nessie/knowledge'
import { DocumentChangedStoredConfigSchema, DocumentChangedTriggerConfigSchema } from '@nessie/schemas'

import {
  refusalsFromZodError,
  TriggerConfigRefusalError,
  type TriggerConfigRefusal,
} from './trigger-config-refusal.js'
import {
  loadDocumentTriggerReaders,
  type DocumentReadRefusal,
  type DocumentTriggerAuthor,
  type DocumentTriggerReaders,
} from './trigger-document-readers.js'
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
 * - **the person setting it up** can read it, asked of their live
 *   entitlement, first: nobody arms an agent on documents they could not
 *   open, and a space, folder or page they cannot read is "no such …";
 * - **the agent** can read it, with its own reach (a document wake runs with
 *   no effective user);
 * - the space is readable by **the whole audience of the target channel** —
 *   project- or organisation-wide, never private, members-only, restricted,
 *   private to an agent or an agent's own home — because every change is
 *   reviewed in that channel.
 *
 * No refusal quotes a page title or a space name (`trigger-document-readers.ts`).
 */

export type DocumentTriggerResolveInput = {
  agent: { id: string; name: string; organizationId: string }
  /** The client config, server-owned keys already stripped. */
  config: Record<string, unknown>
  /**
   * The person creating, editing or resuming it: always a person, asked
   * whether they can read everything it names.
   */
  author: DocumentTriggerAuthor
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

/** Why a document trigger with no person behind it is refused. */
export const DOCUMENT_TRIGGER_NEEDS_A_PERSON =
  'a document trigger is set up, changed and resumed by a person, who must be able to read the documents '
  + 'it watches'

const refuse = (path: string, reason: string): never => {
  throw new TriggerConfigRefusalError([{ path, reason }])
}

const AGENT_REACH = 'bind it to a channel of the project, or share the space with it'

/** A read refusal in words that name nothing the person may not read. */
const readRefusal = (what: 'folder' | 'document', refused: DocumentReadRefusal, agentName: string): string => {
  if (refused === 'missing' || refused === 'person') return `no such ${what}`
  if (refused === 'agent') return `${agentName} cannot read this ${what}'s space; ${AGENT_REACH}`
  return `${agentName} may not read this ${what}: it is restricted, or private to another agent`
}

type PageRef = { id: string; spaceId: string; kind: string; sensitivityTier: string; privateToAgentId: string | null }

/** A named page, or the reason it may not be named. */
const readPage = async (
  prisma: PrismaClient,
  readers: DocumentTriggerReaders,
  organizationId: string,
  pageId: string,
): Promise<{ page: PageRef } | { refused: DocumentReadRefusal }> => {
  const page = await prisma.knowledgePage.findFirst({
    where: { id: pageId, organizationId, deletedAt: null, status: { not: 'archived' } },
    select: { id: true, spaceId: true, kind: true, sensitivityTier: true, privateToAgentId: true },
  })
  if (!page) return { refused: 'missing' }
  const refused = await readers.page(page)
  return refused ? { refused } : { page }
}

/** The space named, or implied by the folder or pages named, or else the project's Documents space. */
const resolveSpace = async (
  prisma: PrismaClient,
  readers: DocumentTriggerReaders,
  input: {
    agentName: string
    organizationId: string
    channel: TriggerTargetChannel
    spaceId?: string
    impliedBy?: string
  },
): Promise<{ record: KnowledgeSpaceRecord; agentReads: boolean }> => {
  const named = input.spaceId ?? input.impliedBy
  const spaceId = named ?? (await prisma.knowledgeSpace.findFirst({
    where: {
      organizationId: input.organizationId,
      projectId: input.channel.projectId,
      deletedAt: null,
      metadata: { path: ['projectDocuments'], equals: true },
    },
    select: { id: true },
  }))?.id
  const access = spaceId ? await readers.space(spaceId) : { refused: 'missing' as const }
  if ('refused' in access) {
    return refuse(
      'spaceId',
      named
        ? 'no such document space in this organisation'
        : `project ${input.channel.project.name} has no Documents space you can read; name the space to watch`,
    )
  }
  if (access.record.projectId !== input.channel.projectId) {
    return refuse(
      'spaceId',
      `this space is in another project than #${input.channel.label} (project ${input.channel.project.name}); `
      + 'a document trigger watches a space of its channel\'s project',
    )
  }
  return access
}

/**
 * Every reader of the channel must be able to read what is reviewed there:
 * the reason a space is narrower than a public project channel, or null.
 * Asked at creation and again every time a change fires. It names no space.
 */
export const documentSpaceAudienceRefusal = (
  space: {
    visibility?: string
    sensitivityTier?: string | null
    privateToAgentId?: string | null
    ownerAgentId?: string | null
  },
  channel: Pick<TriggerTargetChannel, 'label'>,
): string | null => {
  if (space.sensitivityTier === 'restricted') {
    return 'this space holds restricted documents, which only people may read'
  }
  if (space.ownerAgentId || space.privateToAgentId) {
    return 'this space is an agent\'s own space; a document trigger watches a shared project space'
  }
  if (!space.visibility || !CHANNEL_WIDE_VISIBILITIES.has(space.visibility)) {
    return `this space is ${space.visibility ?? 'private'}, narrower than #${channel.label}: every reader of the channel must `
      + 'be able to read the space, so a document trigger watches a project- or organisation-wide space'
  }
  return null
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
  const readers = await loadDocumentTriggerReaders(prisma, {
    organizationId,
    agentId: input.agent.id,
    author: input.author,
  })

  // Every named folder and page is read by both first; one either may not
  // read is refused before anything else is said about it.
  const read = (pageId: string) => readPage(prisma, readers, organizationId, pageId)
  const folder = config.folderPageId ? await read(config.folderPageId) : null
  if (folder && 'refused' in folder) {
    return refuse('folderPageId', readRefusal('folder', folder.refused, input.agent.name))
  }
  if (folder && folder.page.kind !== 'folder') {
    return refuse('folderPageId', `that page is a ${folder.page.kind}, not a folder`)
  }
  const pages = await Promise.all((config.pageIds ?? []).map(read))
  pages.forEach((page, index) => {
    if ('refused' in page) {
      refusals.push({ path: `pageIds[${index}]`, reason: readRefusal('document', page.refused, input.agent.name) })
    }
  })
  if (refusals.length > 0) throw new TriggerConfigRefusalError(refusals)
  const named = pages.flatMap((page) => ('page' in page ? [page.page] : []))
  const impliedBy = folder?.page.spaceId ?? named[0]?.spaceId

  const { record: space, agentReads } = await resolveSpace(prisma, readers, {
    agentName: input.agent.name,
    organizationId,
    channel,
    ...(config.spaceId ? { spaceId: config.spaceId } : {}),
    ...(impliedBy ? { impliedBy } : {}),
  })
  if (folder && folder.page.spaceId !== space.id) {
    refusals.push({ path: 'folderPageId', reason: 'that folder is not in the space this trigger watches' })
  }
  named.forEach((page, index) => {
    const path = `pageIds[${index}]`
    if (page.spaceId !== space.id) {
      refusals.push({ path, reason: 'that document is not in the space this trigger watches' })
    } else if (!(config.kinds as readonly string[]).includes(page.kind)) {
      refusals.push({
        path,
        reason: `that page is a ${page.kind}, and this trigger watches ${config.kinds.join(' and ')} pages`,
      })
    }
  })
  const audience = documentSpaceAudienceRefusal(space, channel)
  if (audience) refusals.push({ path: 'spaceId', reason: audience })
  else if (!agentReads) refusals.push({ path: 'spaceId', reason: `${input.agent.name} cannot read this space; ${AGENT_REACH}` })
  if (refusals.length > 0) throw new TriggerConfigRefusalError(refusals)

  return {
    config: {
      spaceId: space.id,
      folderPageId: folder?.page.id ?? null,
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
 * create would, the person resuming it asked the author's read. A resume with
 * no person behind it is refused.
 */
export const documentTriggerResumeRefusal = async (
  prisma: PrismaClient,
  trigger: {
    agent: { id: string; name: string; organizationId: string | null } | null
    config: unknown
    targetChannelId: string | null
  },
  resumer: DocumentTriggerAuthor | null,
): Promise<string | null> => {
  const agent = trigger.agent
  if (!agent?.organizationId) return 'This document trigger\'s agent is gone, so it cannot be resumed.'
  if (!resumer) return `A document trigger cannot be resumed here: ${DOCUMENT_TRIGGER_NEEDS_A_PERSON}.`
  try {
    await resolveDocumentChangedTrigger(prisma, {
      agent: { id: agent.id, name: agent.name, organizationId: agent.organizationId },
      author: resumer,
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
