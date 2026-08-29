import type { PrismaClient } from '@prisma/client'

import { toAppSlug } from '../apps/app-slug.js'

/**
 * The catalogue `name` an ingested registry server gets.
 *
 * `name` is unique among *public* entries store-wide, and registry rows are
 * public, so collisions are not an edge case: half a dozen publishers ship an
 * `.../github-mcp`. The first fallback is therefore the publisher's own
 * namespace (`acme-github-mcp`) rather than a counter — it says which one this
 * is, where `github-mcp-2` says only that it lost a race.
 *
 * `slug`, the URL identity, is allocated separately by `resolveAvailableAppSlug`
 * from the *display* name: the two answer different questions and a shared
 * derivation would tie a rename of one to the other.
 */

const MAX_NAME_ATTEMPTS = 25
const FALLBACK_NAME = 'mcp-server'

/**
 * `io.github.acme/github-mcp` → `["github-mcp", "io-github-acme-github-mcp",
 * "github-mcp-2", …]`, in the order they should be tried.
 */
export const registryCatalogNameCandidates = (registryName: string): string[] => {
  const segment = registryName.split('/').pop() ?? registryName
  const base = toAppSlug(segment) ?? toAppSlug(registryName) ?? FALLBACK_NAME
  const namespace = registryName.includes('/')
    ? toAppSlug(registryName.split('/')[0] ?? '')
    : null

  const candidates = [base]
  if (namespace && namespace !== base) candidates.push(`${namespace}-${base}`)
  for (let suffix = 2; candidates.length < MAX_NAME_ATTEMPTS; suffix += 1) {
    candidates.push(`${base}-${suffix}`)
  }
  return candidates
}

/**
 * The first candidate no public entry holds, or `null` when every one of them
 * is taken. Resolves against the database as it is now; the partial unique
 * index stays the arbiter, so the caller must still treat a unique violation on
 * insert as a retry rather than trusting this answer to hold.
 */
export const resolveAvailableCatalogName = async (
  prisma: PrismaClient,
  registryName: string,
): Promise<string | null> => {
  for (const candidate of registryCatalogNameCandidates(registryName)) {
    const taken = await prisma.mcpCatalogEntry.findFirst({
      where: { name: candidate, visibility: 'public' },
      select: { id: true },
    })
    if (!taken) return candidate
  }
  return null
}
