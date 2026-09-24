import type { Prisma } from '@prisma/client'

import type { MarkdownAttachmentReader } from './markdown-projection.js'

/**
 * What the native knowledge provider tells the application about, inside the
 * transaction that wrote it. The provider owns storage; everything these hooks
 * start — embedding, publication attention, a document trigger's quiet
 * window — is application policy, wired by each process that builds a
 * provider (the API routes, the worker's tools, the transfer routes).
 */

export type KnowledgeVersionIndexedEvent = {
  organizationId: string
  pageId: string
  versionId: string
}

export type KnowledgePagePublishedEvent = {
  actorUserId: string | null
  organizationId: string
  pageId: string
  projectId: string
  spaceId: string
  versionId: string
}

/**
 * One new version of a page, written by the canonical writer: `createPage`
 * (version 1), `updatePage` (a content, title, summary, label or disclosure
 * change), `addFileVersion` (an upload, a Markdown editor save, an agent's
 * `kb_document_edit`, a spreadsheet snapshot) and `restoreVersion`. A copy
 * (`transfer/copy.ts`) and the agent-core migration write their versions
 * without the writer and never announce one: neither is anybody editing the
 * document. The page's own facts ride along so a consumer that matches pages
 * need not read the page again inside the save.
 */
export type KnowledgeVersionCreatedEvent = {
  organizationId: string
  projectId: string
  spaceId: string
  pageId: string
  /** The page's kind: `document`, `file` or `spreadsheet` (a folder has no versions). */
  kind: string
  versionId: string
  versionNumber: number
  authorType: 'user' | 'agent'
  authorId: string
  origin: string
}

export type NativeKnowledgeProviderOptions = {
  // FileService is the sole byte authority. The native provider uses this
  // reader to derive Markdown projections and never accepts caller text next
  // to an attachment id as proof of what was stored.
  readMarkdownAttachment?: MarkdownAttachmentReader
  // Invoked inside the same transaction that wrote a version's chunk rows —
  // the api wires this to enqueue the `knowledge.embed` job, so a failed
  // enqueue rolls the save back instead of silently losing the embedding pass.
  onVersionChunksReplaced?: (
    tx: Prisma.TransactionClient,
    event: KnowledgeVersionIndexedEvent,
  ) => Promise<void>
  // Invoked inside the publication transaction after the page points at its
  // newly published version. The API owns recipient resolution and the queue
  // outbox because they are app-level attention policy, not knowledge storage.
  onPagePublished?: (
    tx: Prisma.TransactionClient,
    event: KnowledgePagePublishedEvent,
  ) => Promise<void>
  // Invoked inside the save transaction for every version the writer creates
  // (`KnowledgeVersionCreatedEvent`). Unlike `onVersionChunksReplaced`, which
  // fires only when chunk rows were rewritten, this is the one clean "a
  // version exists now" signal: document triggers open their quiet window
  // from it, and a failed enqueue rolls the save back.
  onVersionCreated?: (
    tx: Prisma.TransactionClient,
    event: KnowledgeVersionCreatedEvent,
  ) => Promise<void>
}

/** A migration's version is not an edit, whichever writer carried it. */
const MIGRATION_ORIGINS: ReadonlySet<string> = new Set(['legacy_migration'])

/**
 * Announce one version the writer just created. Called by each of the four
 * writers after the version row and its disclosure are written, inside the
 * same transaction.
 */
export const announceVersionCreated = async (
  tx: Prisma.TransactionClient,
  options: NativeKnowledgeProviderOptions,
  page: { id: string; organizationId: string; projectId: string; spaceId: string; kind: string },
  version: { id: string; versionNumber: number; authorType: string; authorId: string; origin: string },
): Promise<void> => {
  if (!options.onVersionCreated || MIGRATION_ORIGINS.has(version.origin)) return
  await options.onVersionCreated(tx, {
    organizationId: page.organizationId,
    projectId: page.projectId,
    spaceId: page.spaceId,
    pageId: page.id,
    kind: page.kind,
    versionId: version.id,
    versionNumber: version.versionNumber,
    authorType: version.authorType === 'agent' ? 'agent' : 'user',
    authorId: version.authorId,
    origin: version.origin,
  })
}
