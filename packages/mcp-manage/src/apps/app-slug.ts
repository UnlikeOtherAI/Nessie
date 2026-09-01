import type { PrismaClient } from '@prisma/client'

/**
 * `McpCatalogEntry.slug` is the immutable public identity behind `/apps/:slug`.
 * `name` cannot do that job: it is mutable and unique only among public
 * entries, so a rename would break every link already in somebody's hands.
 *
 * The same expression the store migration backfilled with, so a row created by
 * a later registry sync lands on the slug the backfill would have given it.
 */

/** Long enough to stay readable, short enough to stay a URL. */
const MAX_SLUG_LENGTH = 64

/** Bounded because an unbounded probe loop is a denial of service, not a retry. */
const MAX_SLUG_ATTEMPTS = 25

export const toAppSlug = (value: string): string | null => {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '')
  return slug.length > 0 ? slug : null
}

/**
 * The first free slug for `name`, or `null` when there is none — either the
 * name carries no slug-able character at all, or every candidate is taken.
 * `slug` is nullable precisely so an un-sluggable app is still a catalogue
 * row; the caller decides, and nothing throws.
 *
 * This resolves against the database as it is *now*. The unique index remains
 * the arbiter between two concurrent writers, so a caller that inserts must
 * still handle a unique violation rather than trusting this answer to hold.
 */
export const resolveAvailableAppSlug = async (
  prisma: PrismaClient,
  name: string,
  options: { excludeCatalogEntryId?: string } = {},
): Promise<string | null> => {
  const base = toAppSlug(name)
  if (!base) return null

  for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`
    const taken = await prisma.mcpCatalogEntry.findFirst({
      where: {
        slug: candidate,
        ...(options.excludeCatalogEntryId
          ? { id: { not: options.excludeCatalogEntryId } }
          : {}),
      },
      select: { id: true },
    })
    if (!taken) return candidate
  }
  return null
}
