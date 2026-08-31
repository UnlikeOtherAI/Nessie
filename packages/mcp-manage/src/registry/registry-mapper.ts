import {
  sanitizeHttpUrl,
  type AppCategory,
  type AppTrustLevel,
} from '@nessie/schemas'

import { classifyRegistryRemoteAuth, type RegistryRemoteAuth } from './registry-auth.js'
import { classifyRegistryApp } from './registry-categories.js'
import { pickIconCandidate } from './registry-icons.js'
import type { RegistryRecord, RegistryRemote } from './registry-schema.js'

/**
 * One upstream registry record → the catalogue row it should become.
 *
 * Pure and synchronous on purpose. Everything decidable from the record alone
 * is decided here — which remote to install, what to call the app, which links
 * are safe to render, whether it clears the auto-promotion bar — so the whole
 * of it is testable against a real record shape with no database and no
 * network. The two questions that genuinely need the world (does this endpoint
 * pass the SSRF guard, and has a human already touched this row) belong to the
 * importer.
 *
 * A record this refuses is *skipped*, never failed: a package-only server is
 * not an error, it is a server Nessie's remote-only connector model cannot
 * install.
 */

/** Minimum prose before an app is worth showing on a shelf unreviewed. */
const MIN_PROMOTABLE_DESCRIPTION = 40

/**
 * Every ingested app is `community`, without exception.
 *
 * `verified` renders as "Reviewed by Nessie and confirmed with its publisher",
 * and nothing in a registry record can support that sentence: the record's
 * author chooses its own `name`, `title`, `description` *and* its advertised
 * endpoint. Trusting a matching endpoint would let anyone publish
 * `io.github.attacker/notion-official` pointing at Notion's real MCP URL and
 * collect the badge for their own copy. A verified badge is a human judgement
 * about a publisher, so it stays one — made in moderation, never in ingestion.
 */
const INGESTED_TRUST_LEVEL: AppTrustLevel = 'community'

/** Words in a registry name that describe the protocol, not the product. */
const NAME_NOISE = new Set(['mcp', 'server', 'servers'])

export type RegistryAppMapping = {
  registryName: string
  registryVersion: string | null
  /** `title`, else the last path segment of `name`. */
  displayName: string
  description: string
  vendor: string | null
  websiteUrl: string | null
  /**
   * The publisher's own declared icon, persisted so the lazy resolver can try
   * it before guessing. Ingestion previously read no icon field at all, so the
   * one source where somebody actually stated "this is my icon" — about 8% of
   * registry records — was discarded on every sync.
   */
  declaredIconUrl: string | null
  /**
   * Always null today: the registry's server schema publishes no documentation
   * link. Carried so the column has one owner rather than two opinions about
   * where its value comes from.
   */
  documentationUrl: string | null
  repositoryUrl: string | null
  /** The catalogue's existing "for humans" link. */
  sourceUrl: string | null
  protocol: 'http' | 'sse'
  /** Canonical (see `canonicalizeEndpoint`) — this is what gets persisted. */
  endpointUrl: string
  auth: RegistryRemoteAuth
  primaryCategory: AppCategory
  categories: AppCategory[]
  tags: string[]
  aliases: string[]
  /** Always `community`; see `INGESTED_TRUST_LEVEL`. */
  trustLevel: AppTrustLevel
  /**
   * Every auto-promotion gate that the record alone can answer (contract §2).
   * The importer adds the two it cannot: the SSRF verdict on `endpointUrl`, and
   * whether a moderator has already hidden or blocked this app locally.
   */
  promotable: boolean
  upstream: RegistryRecord
  upstreamUpdatedAt: Date | null
}

export type RegistryMappingResult =
  | { ok: true; mapping: RegistryAppMapping }
  | { ok: false; reason: string }

const remoteProtocol = (remote: RegistryRemote): 'http' | 'sse' | null => {
  if (remote.type === 'streamable-http' || remote.type === 'http') return 'http'
  if (remote.type === 'sse') return 'sse'
  return null
}

/** Streamable HTTP over legacy SSE when a server publishes both. */
const pickRemote = (
  remotes: readonly RegistryRemote[],
): { remote: RegistryRemote; protocol: 'http' | 'sse' } | null => {
  for (const wanted of ['http', 'sse'] as const) {
    const remote = remotes.find((candidate) => remoteProtocol(candidate) === wanted)
    if (remote) return { remote, protocol: wanted }
  }
  return null
}

const humanize = (segment: string): string | null => {
  const words = segment
    .split(/[^a-zA-Z0-9]+/)
    .filter((word) => word.length > 0 && !NAME_NOISE.has(word.toLowerCase()))
  if (words.length === 0) return null
  return words
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(' ')
}

type CanonicalEndpoint = {
  /** What gets persisted, matched, and locked against. */
  url: string
  /** Read off the parsed scheme, so `HTTPS://…` is judged as the https it is. */
  isSecure: boolean
}

/**
 * The one canonical spelling of an endpoint: whatever the URL parser makes of
 * the host (lower-cased, default port dropped), no trailing slash, query kept.
 *
 * Two things depend on this being the *persisted* form, not merely a comparison
 * key. The admin endpoint lock matches `defaultTransportConfig.url` as
 * near-exact text, so a row that stored `https://API.Example.com/mcp/` verbatim
 * would sit outside a lock an admin placed on `https://api.example.com/mcp` —
 * the member installs precisely the server that was forbidden. And a record
 * whose endpoint already belongs to a catalogue row must be recognised as that
 * same app rather than added beside it. The query string is preserved because
 * dropping it would change which server Nessie dials; userinfo is not, because
 * a public catalogue row is the last place a publisher's credentials should
 * come to rest.
 */
/**
 * The publisher's own handle out of a registry namespace:
 * `io.github.AgentLineHQ/x` -> `AgentLineHQ`, `com.abundanceapis/x` ->
 * `abundanceapis`, `br.com.9bot/x` -> `9bot`, `ac.inference.sh/x` ->
 * `inference`.
 *
 * The whole namespace is not a publisher name — a card reading
 * "By com.abundanceapis" reads as a rendering bug. But the last segment is not
 * it either: most namespaces are reverse-DNS (`com.acme`), yet plenty are not
 * (`ac.inference.sh`), and blindly taking the last piece publishes a card
 * "By sh". So drop the parts that are registrars or TLDs rather than names,
 * and keep the last of what remains — the piece the publisher actually chose.
 *
 * Null when nothing survives, so the card says nothing rather than inventing
 * an author.
 */
const NAMESPACE_NOISE = new Set([
  'io', 'com', 'org', 'net', 'dev', 'ai', 'app', 'co', 'sh', 'ac', 'me', 'xyz',
  'cloud', 'tech', 'info', 'biz', 'github', 'gitlab', 'br', 'uk', 'us', 'de',
  'fr', 'jp', 'in', 'eu', 'ca', 'au', 'nl', 'it', 'es', 'ru', 'cn',
])

const publisherHandle = (registryName: string): string | null => {
  if (!registryName.includes('/')) return null
  const segments = (registryName.split('/')[0] ?? '')
    .split('.')
    .filter((part) => part.length > 0)
  const named = segments.filter((part) => !NAMESPACE_NOISE.has(part.toLowerCase()))
  // Everything was noise (a bare `com.io`): say nothing rather than guess.
  return named.length > 0 ? named[named.length - 1] ?? null : null
}

const canonicalizeEndpoint = (url: string): CanonicalEndpoint | null => {
  const safe = sanitizeHttpUrl(url)
  if (!safe) return null
  const parsed = new URL(safe)
  const path = parsed.pathname.replace(/\/+$/, '')
  return {
    url: `${parsed.protocol}//${parsed.host}${path}${parsed.search}`,
    isSecure: parsed.protocol === 'https:',
  }
}

/** The canonical endpoint of an arbitrary URL, or nothing if it is not http(s). */
export const normalizeEndpoint = (url: string): string | null =>
  canonicalizeEndpoint(url)?.url ?? null

const parseTimestamp = (value: string | null): Date | null => {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export const mapRegistryRecord = (record: RegistryRecord): RegistryMappingResult => {
  if (!record.isLatest) return { ok: false, reason: 'not the latest version' }
  if (record.status !== 'active') {
    return { ok: false, reason: `registry status is ${record.status ?? 'unknown'}` }
  }

  const picked = pickRemote(record.remotes)
  if (!picked) return { ok: false, reason: 'no HTTP or SSE remote' }

  // http(s) only, before anything is persisted. A `javascript:` or `file:`
  // endpoint is not a transport Nessie could dial and not a string any surface
  // should hold.
  const endpoint = canonicalizeEndpoint(picked.remote.url)
  if (!endpoint) return { ok: false, reason: 'remote endpoint is not an http(s) URL' }

  const segment = record.name.split('/').pop() ?? record.name
  const title = record.title?.trim()
  const derivedName = title && title.length > 0 ? title : humanize(segment)
  const description = record.description.trim()
  const classification = classifyRegistryApp({
    name: record.name,
    title: record.title,
    description,
  })

  return {
    ok: true,
    mapping: {
      registryName: record.name,
      registryVersion: record.version,
      // The row exists even when no display name resolves — `name` is always
      // something. It just does not get promoted; see `promotable` below.
      displayName: derivedName ?? record.name,
      description,
      vendor: publisherHandle(record.name),
      websiteUrl: sanitizeHttpUrl(record.websiteUrl),
      // Keep all publisher metadata in `upstream`; this is just the best
      // theme-neutral, card-sized raster pointer for legacy and lazy callers.
      // The resolver reselects from the complete snapshot before it fetches.
      declaredIconUrl: pickIconCandidate(record.declaredIcons),
      documentationUrl: null,
      repositoryUrl: sanitizeHttpUrl(record.repositoryUrl),
      sourceUrl:
        sanitizeHttpUrl(record.websiteUrl) ?? sanitizeHttpUrl(record.repositoryUrl),
      protocol: picked.protocol,
      endpointUrl: endpoint.url,
      auth: classifyRegistryRemoteAuth(picked.remote),
      primaryCategory: classification.primaryCategory,
      categories: classification.categories,
      tags: classification.tags,
      aliases: classification.aliases,
      trustLevel: INGESTED_TRUST_LEVEL,
      promotable:
        derivedName !== null
        && description.length >= MIN_PROMOTABLE_DESCRIPTION
        && endpoint.isSecure,
      upstream: record,
      upstreamUpdatedAt: parseTimestamp(record.updatedAt ?? record.publishedAt),
    },
  }
}
