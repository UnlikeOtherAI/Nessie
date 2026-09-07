import type { PrismaClient } from '@prisma/client'
import { parseRunId, type PartialJsonScanner } from '@nessie/schemas'

import { settleDocumentSession } from './document-session-claim.js'

/**
 * Where the document is going: resolve it, record it, announce it.
 *
 * A destination has three separate lives and this module owns all three, which
 * is why they are here rather than beside the streaming lanes. The **session
 * row** carries the authorized target (`title`, `space_id`, `parent_page_id`)
 * and is the only one of the three that decides anything — the save reads it.
 * The **names** (a space's name, a parent page's title) are presentation-only
 * and are never stored. And the **`stream.document.meta` event** is what puts
 * the destination in the popup's address bar while the document is still being
 * written.
 *
 * Two callers, one for each mode. A compose learns its target from the model's
 * partially-arrived arguments, so it announces as soon as a title or a space id
 * has committed; an edit knows it from the document it opened, so it announces
 * once, at session creation. Both are best-effort: a destination that cannot be
 * resolved must never fail a run that is otherwise writing a perfectly good
 * document.
 */

/** The slice of a tracked call this module reads and marks. */
export type DocumentTargetCall = {
  claimToken: string | null
  metaPublished: boolean
  scanner: PartialJsonScanner
  sessionId: string | null
}

type TargetAnnouncerInput = {
  disclosure: {
    beforeRestrictedReadable: () => Promise<void>
    isRestricted: () => boolean
  }
  organizationId: string
  prisma: PrismaClient
  publish: (
    event: 'stream.document.meta',
    data: {
      parentPageId?: string
      parentTitle?: string
      runId: ReturnType<typeof parseRunId>
      sessionId: string
      spaceId?: string
      spaceName?: string
      title?: string
    },
  ) => Promise<void>
  runId: string
}

export const createDocumentTargetAnnouncer = (input: TargetAnnouncerInput) => {
  const spaceName = async (spaceId: string): Promise<string | undefined> => {
    const space = await input.prisma.knowledgeSpace.findFirst({
      select: { name: true },
      where: { id: spaceId, organizationId: input.organizationId },
    })
    return space?.name
  }

  return {
    /**
     * A compose target, from the arguments as far as they have committed. Fires
     * at most once per call: the first title or space id the model settles on is
     * the one the address bar shows, and a later correction reaches the person
     * as the saved document rather than as a moving target.
     */
    compose: async (call: DocumentTargetCall): Promise<void> => {
      const sessionId = call.sessionId
      if (!sessionId || call.metaPublished) return
      const fields = call.scanner.fields()
      const title = fields.title
      const spaceId = fields.spaceId
      if (!title && !spaceId) return
      call.metaPublished = true

      const restricted = input.disclosure.isRestricted()
      let resolvedSpaceName: string | undefined
      let parentTitle: string | undefined
      try {
        if (restricted) await input.disclosure.beforeRestrictedReadable()
        if (spaceId && !restricted) resolvedSpaceName = await spaceName(spaceId)
        if (fields.parentPageId && !restricted) {
          const parent = await input.prisma.knowledgePage.findFirst({
            select: { title: true },
            where: { id: fields.parentPageId, organizationId: input.organizationId },
          })
          parentTitle = parent?.title
        }
        await settleDocumentSession(input.prisma, {
          claimToken: call.claimToken,
          data: {
            parentPageId: fields.parentPageId ?? null,
            spaceId: spaceId ?? null,
            title: title ?? null,
          },
          sessionId,
          settle: 'record the compose target on',
        })
      } catch (error) {
        console.warn('[worker] document stream meta resolve failed', error)
      }

      if (input.disclosure.isRestricted()) return
      await input.publish('stream.document.meta', {
        parentPageId: fields.parentPageId,
        parentTitle,
        runId: parseRunId(input.runId),
        sessionId,
        spaceId,
        spaceName: resolvedSpaceName,
        title,
      })
    },

    /**
     * An edit target, from the document the session opened. Recorded on the row
     * before the name lookup, because the row is the authorized target and the
     * name is decoration that a restricted run must not fetch at all.
     */
    edit: async (
      call: DocumentTargetCall,
      sessionId: string,
      base: { parentPageId: string | null; spaceId: string; title: string },
    ): Promise<void> => {
      call.metaPublished = true
      await settleDocumentSession(input.prisma, {
        claimToken: call.claimToken,
        data: { parentPageId: base.parentPageId, spaceId: base.spaceId, title: base.title },
        sessionId,
        settle: 'record the edit target on',
      })
    },

    /** The edit target's names, published after `stream.document.start`. */
    publishEdit: async (
      sessionId: string,
      base: { parentPageId: string | null; spaceId: string; title: string },
    ): Promise<void> => {
      // Names are presentation-only; the session keeps the authorized target.
      if (input.disclosure.isRestricted()) return
      const resolved = await spaceName(base.spaceId)
      // Re-check after the awaited name lookup.
      if (input.disclosure.isRestricted()) return
      await input.publish('stream.document.meta', {
        parentPageId: base.parentPageId ?? undefined,
        runId: parseRunId(input.runId),
        sessionId,
        spaceId: base.spaceId,
        spaceName: resolved,
        title: base.title,
      })
    },
  }
}
