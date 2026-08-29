import type { McpAppCategory, McpAppTrustLevel } from '@prisma/client'

import { mapRegistryRecord, type RegistryAppMapping } from './registry-mapper.js'
import { readUpstreamSnapshot } from './registry-schema.js'

/**
 * What a re-sync is allowed to overwrite.
 *
 * Curation must survive every future sync — that is contract §4 — and the only
 * honest way to know whether a value is a curator's is to know what the
 * previous sync wrote. So the previous `upstream` snapshot is re-run through
 * the same pure mapper, and each column is compared against the value that run
 * would have produced:
 *
 * - the stored value still equals what sync wrote → sync owns it, write the new
 *   one;
 * - the stored value is empty → nobody owns it, write the new one;
 * - anything else → a human changed it, leave it alone. Forever.
 *
 * The comparison errs toward the curator by construction. An unreadable
 * snapshot, or a mapper whose rules have since changed, makes every non-empty
 * column look human-authored and the sync becomes a no-op for that row. Losing
 * an upstream description is recoverable; silently overwriting somebody's copy
 * with a vendor's marketing line is not.
 *
 * Three columns are deliberately absent and never re-synced at all:
 * `name` (unique among public entries — a rename could collide with a row this
 * sync does not own), `slug` (the immutable identity behind `/apps/:slug`), and
 * `moderationState` (a promotion decision, made in the importer).
 */

export type TransportConfig = {
  transport: 'http' | 'sse'
  url: string
}

/** Every column registry sync is entitled to write after creation. */
export type SyncableAppFields = {
  label: string
  description: string
  vendor: string | null
  sourceUrl: string | null
  displayName: string | null
  shortDescription: string | null
  websiteUrl: string | null
  documentationUrl: string | null
  repositoryUrl: string | null
  primaryCategory: McpAppCategory
  categories: McpAppCategory[]
  tags: string[]
  aliases: string[]
  trustLevel: McpAppTrustLevel
  defaultTransportConfig: TransportConfig
}

export const syncableFieldsFromMapping = (
  mapping: RegistryAppMapping,
): SyncableAppFields => ({
  label: mapping.displayName,
  description: mapping.description,
  vendor: mapping.vendor,
  sourceUrl: mapping.sourceUrl,
  displayName: mapping.displayName,
  shortDescription: mapping.description,
  websiteUrl: mapping.websiteUrl,
  documentationUrl: mapping.documentationUrl,
  repositoryUrl: mapping.repositoryUrl,
  primaryCategory: mapping.primaryCategory,
  categories: mapping.categories,
  tags: mapping.tags,
  aliases: mapping.aliases,
  trustLevel: mapping.trustLevel,
  defaultTransportConfig: { transport: mapping.protocol, url: mapping.endpointUrl },
})

const sameValue = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => sameValue(item, b[index]))
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const left = a as Record<string, unknown>
    const right = b as Record<string, unknown>
    const keys = new Set([...Object.keys(left), ...Object.keys(right)])
    return [...keys].every((key) => sameValue(left[key], right[key]))
  }
  return a === b
}

/**
 * "Nobody has decided this yet." `other` and `unknown` are the column defaults
 * the store's own read treats as absent, so a later sync is free to improve
 * them; every other value is somebody's answer.
 */
const isUnset = (key: keyof SyncableAppFields, value: unknown): boolean => {
  if (value === null || value === undefined) return true
  if (Array.isArray(value)) return value.length === 0
  if (key === 'defaultTransportConfig') {
    const config = value as Record<string, unknown>
    return typeof config.url !== 'string' || config.url.length === 0
  }
  // Two columns are NOT NULL with a default, so "no curator has touched this"
  // is the default value rather than null. These must be tested BEFORE the
  // generic string check below, which would otherwise return false for the
  // non-empty strings 'other' and 'unknown' and mark an untouched column as
  // curator-owned — leaving every adopted row permanently uncategorised.
  if (key === 'primaryCategory') return value === 'other'
  if (key === 'trustLevel') return value === 'unknown'
  if (typeof value === 'string') return value.trim().length === 0
  return false
}

export type MergeRegistryUpdateInput = {
  /** The row as it stands, restricted to the columns sync may write. */
  current: SyncableAppFields
  /** `McpCatalogEntry.upstream` from the previous sync, unparsed. */
  storedUpstream: unknown
  next: SyncableAppFields
}

/**
 * The subset of `next` that may actually be written. An empty object means the
 * row is entirely curator-owned and this sync changes nothing but provenance.
 */
export const mergeRegistryUpdate = (
  input: MergeRegistryUpdateInput,
): Partial<SyncableAppFields> => {
  const snapshot = readUpstreamSnapshot(input.storedUpstream)
  const previousResult = snapshot ? mapRegistryRecord(snapshot) : null
  const previous =
    previousResult?.ok === true
      ? syncableFieldsFromMapping(previousResult.mapping)
      : null

  const update: Partial<SyncableAppFields> = {}
  for (const key of Object.keys(input.next) as (keyof SyncableAppFields)[]) {
    const current = input.current[key]
    const owned = isUnset(key, current)
      || (previous !== null && sameValue(current, previous[key]))
    if (!owned) continue
    if (sameValue(current, input.next[key])) continue
    Object.assign(update, { [key]: input.next[key] })
  }
  return update
}
