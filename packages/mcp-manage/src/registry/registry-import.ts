import type { McpAppModerationState, PrismaClient } from '@prisma/client'

import { resolveAvailableAppSlug } from '../apps/app-slug.js'
import { isUniqueViolation } from '../mcp-catalog-guards.js'
import { assertMcpUrlSafe } from '../mcp-security.js'
import {
  iterateRegistryPages,
  type RegistryFetchOptions,
} from './registry-client.js'
import {
  mapRegistryRecord,
  normalizeEndpoint,
  type RegistryAppMapping,
} from './registry-mapper.js'
import {
  mergeRegistryUpdate,
  syncableFieldsFromMapping,
  type SyncableAppFields,
} from './registry-merge.js'
import { resolveAvailableCatalogName } from './registry-naming.js'
import { parseRegistryEntry } from './registry-schema.js'

/**
 * Fill the App Store from the official MCP registry.
 *
 * The whole run is bracketed by one `McpRegistrySyncRun` row, so a partial or
 * failed import is visible instead of silent. Its counters partition every
 * fetched record into exactly one outcome:
 *
 * - **created / updated** — the record became, or reconciled with, a catalogue
 *   row. An update that finds nothing to change still counts as updated: the
 *   row was reconciled, it simply needed no write.
 * - **skipped** — the record does not apply. A superseded version, a
 *   deprecated server, a package-only server Nessie's remote-only connector
 *   model cannot install, or an endpoint the SSRF guard refuses. None of these
 *   is an error.
 * - **failed** — the record could not be read or could not be written. One
 *   malformed record must never fail the import (contract §6), so each is
 *   counted, described in the run's `failures`, and stepped over.
 *
 * Idempotent by construction: rows are matched on the stable `registryName`
 * and, failing that, on the endpoint they already point at, and
 * `mergeRegistryUpdate` writes only columns the previous sync owns. Running
 * this twice produces the same catalogue and no curated value moves.
 */

/**
 * Provenance for a row no person authored, following `seed-connectors.ts`.
 * `createdBy` is NOT NULL and carries no FK precisely so a system-authored row
 * can exist without inventing an author.
 */
const NIL_UUID = '00000000-0000-0000-0000-000000000000'

/** Enough to diagnose a systematic problem; not a log to trawl. */
const MAX_FAILURE_DETAILS = 50

/** A name collision is a retry, not a defeat — but a bounded one. */
const CREATE_ATTEMPTS = 3

/**
 * Where the sweep has got to, reported once per page.
 *
 * A full walk is dozens of requests over several minutes, run either from a
 * terminal (`sync:registry`) or in the background of an API process behind the
 * owner's sync button. Both need to distinguish "still working" from "hung",
 * and the CLI's closing line needs `serversSkipped`, which is a counter of the
 * sweep rather than a column on the run row and so cannot be read back
 * afterwards.
 */
export type RegistrySyncProgress = {
  runId: string
  /** 1-based page of the registry's cursor walk. */
  page: number
  serversFetched: number
  serversCreated: number
  serversUpdated: number
  serversSkipped: number
  serversFailed: number
}

export type SyncRegistryOptions = RegistryFetchOptions & {
  source?: string
  /**
   * The SSRF verdict on a server's advertised endpoint. Injectable so the
   * import is testable without DNS; production takes `assertMcpUrlSafe`.
   */
  assertEndpointSafe?: (url: string) => Promise<unknown>
  /** Called once per fetched page, empty pages included. */
  onProgress?: (progress: RegistrySyncProgress) => void
}

export type SyncRegistryResult = {
  runId: string
  serversFetched: number
  serversCreated: number
  serversUpdated: number
  serversSkipped: number
  serversFailed: number
  /** Set when the run itself broke — the registry went away mid-page. */
  error: string | null
}

type UpsertOutcome = 'created' | 'updated' | 'skipped'

type ExistingAppRow = SyncableAppFields & {
  id: string
  moderationState: McpAppModerationState
  upstream: unknown
}

const EXISTING_SELECT = {
  id: true,
  label: true,
  description: true,
  vendor: true,
  sourceUrl: true,
  displayName: true,
  shortDescription: true,
  websiteUrl: true,
  documentationUrl: true,
  repositoryUrl: true,
  primaryCategory: true,
  categories: true,
  tags: true,
  aliases: true,
  trustLevel: true,
  defaultTransportConfig: true,
  moderationState: true,
  upstream: true,
} as const

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Endpoints repeat across a publisher's servers, and the guard resolves DNS.
 * Memoised per origin for the life of one run so a sweep of thousands of
 * records does not re-ask the same question hundreds of times; a fresh run
 * re-resolves, so a host that has since moved is caught.
 */
const memoizedGuard = (
  assertEndpointSafe: (url: string) => Promise<unknown>,
): ((url: string) => Promise<boolean>) => {
  const verdicts = new Map<string, Promise<boolean>>()
  return (url: string) => {
    const origin = new URL(url).origin
    const cached = verdicts.get(origin)
    if (cached) return cached
    const verdict = assertEndpointSafe(url).then(() => true, () => false)
    verdicts.set(origin, verdict)
    return verdict
  }
}

/**
 * Auto-promotion is objective and one-directional (contract §2). A record that
 * clears every gate lifts a row nobody has looked at into the store; a record
 * that stops clearing them does **not** pull an app back out. Removal is a
 * moderation decision, and `hidden` / `blocked` / `approved` are decisions
 * already made — sync never overrules one.
 */
const promotedModerationState = (
  current: McpAppModerationState,
  promotable: boolean,
): McpAppModerationState | null =>
  promotable && current === 'discovered' ? 'curated' : null

const createRegistryApp = async (
  prisma: PrismaClient,
  mapping: RegistryAppMapping,
): Promise<UpsertOutcome> => {
  const fields = syncableFieldsFromMapping(mapping)
  let conflict: unknown = null

  for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt += 1) {
    const name = await resolveAvailableCatalogName(prisma, mapping.registryName)
    if (!name) throw new Error('every catalogue name candidate is taken')
    // A null slug is allowed: the store resolves an app by slug *or* id, so a
    // pathological collision costs the readable URL and never the row.
    const slug = await resolveAvailableAppSlug(prisma, mapping.displayName)

    try {
      await prisma.mcpCatalogEntry.create({
        data: {
          organizationId: null,
          name,
          label: fields.label,
          description: fields.description,
          protocol: mapping.protocol,
          authMethod: mapping.auth.authMethod,
          authConfig: mapping.auth.authConfig,
          defaultTransportConfig: fields.defaultTransportConfig,
          vendor: fields.vendor,
          sourceUrl: fields.sourceUrl,
          status: 'published',
          visibility: 'public',
          ownerUserId: null,
          createdBy: NIL_UUID,
          slug,
          displayName: fields.displayName,
          shortDescription: fields.shortDescription,
          websiteUrl: fields.websiteUrl,
          documentationUrl: fields.documentationUrl,
          repositoryUrl: fields.repositoryUrl,
          primaryCategory: fields.primaryCategory,
          categories: fields.categories,
          tags: fields.tags,
          aliases: fields.aliases,
          trustLevel: fields.trustLevel,
          moderationState: mapping.promotable ? 'curated' : 'discovered',
          appSource: 'mcp_registry',
          distribution: 'remote',
          registryName: mapping.registryName,
          registryVersion: mapping.registryVersion,
          upstream: mapping.upstream,
          upstreamUpdatedAt: mapping.upstreamUpdatedAt,
        },
      })
      return 'created'
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
      conflict = error
    }
  }
  throw conflict ?? new Error('unable to allocate a catalogue name')
}

const updateRegistryApp = async (
  prisma: PrismaClient,
  existing: ExistingAppRow,
  mapping: RegistryAppMapping,
  /** Set only when this row is being taken over; see `loadAdoptableApps`. */
  adopt: boolean,
): Promise<UpsertOutcome> => {
  const update = mergeRegistryUpdate({
    current: existing,
    storedUpstream: existing.upstream,
    next: syncableFieldsFromMapping(mapping),
  })
  const moderationState = promotedModerationState(
    existing.moderationState,
    mapping.promotable,
  )

  await prisma.mcpCatalogEntry.update({
    where: { id: existing.id },
    data: {
      ...update,
      ...(moderationState ? { moderationState } : {}),
      // Adoption writes only provenance. Everything a person can see went
      // through the same merge as any other re-sync, so a curator's label,
      // copy, or endpoint survives being adopted exactly as it survives being
      // updated: the row now *has* an upstream, it did not become one.
      ...(adopt ? { registryName: mapping.registryName, appSource: 'mcp_registry' } : {}),
      registryVersion: mapping.registryVersion,
      upstream: mapping.upstream,
      upstreamUpdatedAt: mapping.upstreamUpdatedAt,
    },
  })
  return 'updated'
}

const endpointKeyOf = (transportConfig: unknown): string | null => {
  if (!transportConfig || typeof transportConfig !== 'object') return null
  const url = (transportConfig as Record<string, unknown>).url
  return typeof url === 'string' && url.length > 0 ? normalizeEndpoint(url) : null
}

/**
 * The catalogue rows an ingested record should *become* rather than sit beside,
 * keyed by canonical endpoint.
 *
 * `registryName` alone cannot see them: `context7` is seeded by
 * `seed-connectors.ts` with no registry name at all, so the record advertising
 * the same `https://mcp.context7.com/mcp` inserted a rival row named
 * `context7-2` and the store showed the same server twice, with two detail
 * pages and a doubled count. Matching the endpoint as well makes one server one
 * app, which is the whole premise of `/apps` being a face on `McpCatalogEntry`.
 *
 * Scoped to instance-global published rows — precisely the rows a registry
 * create would collide with. An organisation's own entry is deliberately left
 * alone: adopting it would bind a public app to one tenant and take it away
 * from every other organisation, which is a worse defect than one org seeing
 * its own connector beside the store's.
 *
 * Read once per run, and a row is handed out once: two registry records
 * advertising the same endpoint must not both claim it and overwrite each
 * other's provenance on every sweep.
 */
const loadAdoptableApps = async (
  prisma: PrismaClient,
): Promise<Map<string, ExistingAppRow>> => {
  const rows = await prisma.mcpCatalogEntry.findMany({
    where: {
      registryName: null,
      organizationId: null,
      visibility: 'public',
      status: 'published',
    },
    // Deterministic when two hand-authored rows share an endpoint: the elder
    // is the one the store has been showing.
    orderBy: { createdAt: 'asc' },
    select: EXISTING_SELECT,
  })

  const byEndpoint = new Map<string, ExistingAppRow>()
  for (const row of rows as unknown as ExistingAppRow[]) {
    const key = endpointKeyOf(row.defaultTransportConfig)
    if (!key || byEndpoint.has(key)) continue
    byEndpoint.set(key, row)
  }
  return byEndpoint
}

const upsertRegistryApp = async (
  prisma: PrismaClient,
  mapping: RegistryAppMapping,
  isEndpointSafe: (url: string) => Promise<boolean>,
  adoptable: Map<string, ExistingAppRow>,
): Promise<UpsertOutcome> => {
  // Before anything is persisted. A row whose transport points at an internal
  // address is a hazard to keep, not merely one to leave unpromoted.
  if (!(await isEndpointSafe(mapping.endpointUrl))) return 'skipped'

  const existing = await prisma.mcpCatalogEntry.findFirst({
    where: { registryName: mapping.registryName },
    select: EXISTING_SELECT,
  })
  if (existing) {
    return updateRegistryApp(prisma, existing as unknown as ExistingAppRow, mapping, false)
  }

  const adopted = adoptable.get(mapping.endpointUrl)
  if (adopted) {
    adoptable.delete(mapping.endpointUrl)
    return updateRegistryApp(prisma, adopted, mapping, true)
  }
  return createRegistryApp(prisma, mapping)
}

export const syncRegistry = async (
  prisma: PrismaClient,
  options: SyncRegistryOptions = {},
): Promise<SyncRegistryResult> => {
  const run = await prisma.mcpRegistrySyncRun.create({
    data: { source: options.source ?? 'mcp-registry' },
  })

  const isEndpointSafe = memoizedGuard(
    options.assertEndpointSafe ?? ((url: string) => assertMcpUrlSafe(url)),
  )
  const adoptable = await loadAdoptableApps(prisma)
  const counts = { created: 0, failed: 0, fetched: 0, skipped: 0, updated: 0 }
  const failures: Array<{ registryName: string | null; reason: string }> = []
  let runError: string | null = null

  const recordFailure = (registryName: string | null, reason: string): void => {
    counts.failed += 1
    if (failures.length < MAX_FAILURE_DETAILS) failures.push({ registryName, reason })
  }

  const reportProgress = (page: number): void =>
    options.onProgress?.({
      runId: run.id,
      page,
      serversFetched: counts.fetched,
      serversCreated: counts.created,
      serversUpdated: counts.updated,
      serversSkipped: counts.skipped,
      serversFailed: counts.failed,
    })

  try {
    for await (const { page, records } of iterateRegistryPages(options)) {
      for (const raw of records) {
        counts.fetched += 1

        const parsed = parseRegistryEntry(raw)
        if (!parsed.ok) {
          recordFailure(null, `unreadable registry record: ${parsed.reason}`)
          continue
        }

        const mapped = mapRegistryRecord(parsed.record)
        if (!mapped.ok) {
          counts.skipped += 1
          continue
        }

        try {
          counts[
            await upsertRegistryApp(prisma, mapped.mapping, isEndpointSafe, adoptable)
          ] += 1
        } catch (error) {
          recordFailure(parsed.record.name, errorMessage(error))
        }
      }
      // After the page is written, so the numbers describe work that is done.
      reportProgress(page)
    }
  } catch (error) {
    // The registry itself stopped answering. Everything already imported
    // stands; the run says why it ended early.
    runError = errorMessage(error)
  }

  await prisma.mcpRegistrySyncRun.update({
    where: { id: run.id },
    data: {
      completedAt: new Date(),
      serversFetched: counts.fetched,
      serversCreated: counts.created,
      serversUpdated: counts.updated,
      serversFailed: counts.failed,
      error: runError,
      failures,
    },
  })

  return {
    runId: run.id,
    serversFetched: counts.fetched,
    serversCreated: counts.created,
    serversUpdated: counts.updated,
    serversSkipped: counts.skipped,
    serversFailed: counts.failed,
    error: runError,
  }
}
