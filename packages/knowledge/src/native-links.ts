import { Prisma } from '@prisma/client'

// Wikilink maintenance: keeps `knowledge_page_links` in lockstep with the
// `<a data-kb-page-id="…">` / `<a data-kb-unresolved-title="…">` anchors the
// admin editor serializes into a page's body HTML. Extraction is pure (no DB),
// so it is unit-testable without a database; replace/resolve are the two
// write operations the provider hooks into on every new version and on
// page-create/rename.

export type ExtractedWikilink = {
  targetPageId: string | null
  targetTitle: string
}

// One pass over every anchor tag; branch on which data-kb-* attribute (if
// either) is present. Anchor text may itself carry inline formatting tags
// (e.g. `<strong>`), so the resolved-link title is the anchor's inner HTML
// with tags stripped, not the raw innerHTML.
const ANCHOR_RE = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
const PAGE_ID_ATTR_RE = /data-kb-page-id="([^"]*)"/i
const UNRESOLVED_TITLE_ATTR_RE = /data-kb-unresolved-title="([^"]*)"/i
const TAG_RE = /<[^>]+>/g

// Only the entities the admin editor actually emits when serializing
// wikilinks — not a general-purpose HTML entity decoder.
const decodeBasicEntities = (value: string): string =>
  value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")

// Pure regex parse of the wikilink anchors embedded in a page's body HTML.
// Dedupes by (targetPageId ?? '', lowercased title) so a page linked twice in
// one body only produces one row.
export const extractWikilinks = (bodyHtml: string | null): ExtractedWikilink[] => {
  if (!bodyHtml) return []
  const seen = new Set<string>()
  const links: ExtractedWikilink[] = []
  for (const match of bodyHtml.matchAll(ANCHOR_RE)) {
    const attrs = match[1] ?? ''
    const inner = match[2] ?? ''
    const pageIdMatch = attrs.match(PAGE_ID_ATTR_RE)
    const unresolvedMatch = attrs.match(UNRESOLVED_TITLE_ATTR_RE)
    let targetPageId: string | null = null
    let rawTitle: string | null = null
    if (pageIdMatch) {
      targetPageId = pageIdMatch[1] ?? null
      rawTitle = inner.replace(TAG_RE, '')
    } else if (unresolvedMatch) {
      rawTitle = unresolvedMatch[1] ?? null
    } else {
      continue
    }
    const title = decodeBasicEntities(rawTitle ?? '').trim()
    if (!title) continue
    const dedupeKey = `${targetPageId ?? ''}::${title.toLowerCase()}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    links.push({ targetPageId, targetTitle: title })
  }
  return links
}

// Best-effort resolution of an unresolved wikilink title: exact
// case-insensitive match against live (non-deleted) pages in the org,
// preferring a page in the same space as the link's source when more than
// one page shares the title.
const resolveTitleToPageId = async (
  tx: Prisma.TransactionClient,
  input: { organizationId: string; title: string; preferSpaceId: string | null },
): Promise<string | null> => {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM knowledge_pages
    WHERE organization_id = ${input.organizationId}::uuid
      AND deleted_at IS NULL
      AND lower(title) = lower(${input.title})
    ORDER BY
      ${input.preferSpaceId
        ? Prisma.sql`(space_id = ${input.preferSpaceId}::uuid) DESC,`
        : Prisma.empty}
      updated_at DESC
    LIMIT 1
  `)
  return rows[0]?.id ?? null
}

export type ReplaceKnowledgePageLinksInput = {
  organizationId: string
  sourcePageId: string
  bodyHtml: string | null
}

// Recomputes every outgoing wikilink row for a page's new body: deletes the
// old set, extracts the new set, attempts resolution of any still-unresolved
// titles, then inserts. Self-links (a page linking to itself) are dropped —
// they add no navigational value and would otherwise dangle on page delete.
export const replaceKnowledgePageLinks = async (
  tx: Prisma.TransactionClient,
  input: ReplaceKnowledgePageLinksInput,
): Promise<void> => {
  await tx.knowledgePageLink.deleteMany({ where: { sourcePageId: input.sourcePageId } })

  const extracted = extractWikilinks(input.bodyHtml).filter(
    (link) => link.targetPageId !== input.sourcePageId,
  )
  if (extracted.length === 0) return

  // Only look up the source page's space (for same-space preference) when
  // there is actually an unresolved title to resolve — an all-resolved body
  // needs no resolution query at all.
  const hasUnresolved = extracted.some((link) => link.targetPageId === null)
  const preferSpaceId = hasUnresolved
    ? (await tx.knowledgePage.findFirst({
        where: { id: input.sourcePageId, organizationId: input.organizationId },
        select: { spaceId: true },
      }))?.spaceId ?? null
    : null

  const rows = await Promise.all(
    extracted.map(async (link) => {
      if (link.targetPageId) return link
      const resolved = await resolveTitleToPageId(tx, {
        organizationId: input.organizationId,
        title: link.targetTitle,
        preferSpaceId,
      })
      return { targetPageId: resolved, targetTitle: link.targetTitle }
    }),
  )

  await tx.knowledgePageLink.createMany({
    data: rows.map((row) => ({
      organizationId: input.organizationId,
      sourcePageId: input.sourcePageId,
      targetPageId: row.targetPageId,
      targetTitle: row.targetTitle,
    })),
  })
}

export type ResolveLinksToPageInput = {
  organizationId: string
  pageId: string
  title: string
}

// Fires whenever a page is created (or renamed) with a title that some
// existing unresolved wikilink names — repoints those links at the new/renamed
// page by id. Rename never un-resolves an already-resolved link: those are
// tracked by id, not by title, so they stay pointed at the right page.
export const resolveLinksToPage = async (
  tx: Prisma.TransactionClient,
  input: ResolveLinksToPageInput,
): Promise<void> => {
  await tx.$executeRaw(Prisma.sql`
    UPDATE knowledge_page_links
    SET target_page_id = ${input.pageId}::uuid
    WHERE organization_id = ${input.organizationId}::uuid
      AND target_page_id IS NULL
      AND lower(target_title) = lower(${input.title})
  `)
}
