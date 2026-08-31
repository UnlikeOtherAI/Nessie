import { z } from 'zod'

/**
 * The official MCP registry's wire shape, as far as ingestion consumes it.
 *
 * Two properties matter more than completeness:
 *
 * 1. **A page parses even when a record does not.** `servers` is an array of
 *    `unknown` here, and each element is parsed on its own by
 *    `parseRegistryEntry`. One malformed record must never cost the other
 *    ninety-nine on its page — the importer counts it and moves on.
 * 2. **Unknown fields pass through.** The upstream schema is versioned per
 *    release (`$schema: …/2025-12-11/server.schema.json`) and gains fields; a
 *    strict object would turn every upstream addition into a total import
 *    failure. Zod strips what it does not name, which is the behaviour we want.
 *
 * `library.ts` also parses this endpoint, deliberately more narrowly: it maps
 * search hits to an install-picker entry and never looks at `_meta`. Ingestion
 * needs the provenance block (`status`, `isLatest`, timestamps) because those
 * are its admission gates, so it owns this parse.
 */

/** Where the registry itself — rather than the server's publisher — speaks. */
export const REGISTRY_OFFICIAL_META_KEY =
  'io.modelcontextprotocol.registry/official'

const RegistryRemoteHeaderSchema = z.object({
  name: z.string(),
  value: z.string().optional(),
  isRequired: z.boolean().optional(),
  isSecret: z.boolean().optional(),
  description: z.string().optional(),
})

const RegistryRemoteSchema = z.object({
  type: z.string(),
  url: z.string(),
  /** Kept because the credential a server expects is derived from them. */
  headers: z.array(RegistryRemoteHeaderSchema).optional(),
})

const RegistryOfficialMetaSchema = z.object({
  status: z.string().optional(),
  isLatest: z.boolean().optional(),
  publishedAt: z.string().optional(),
  updatedAt: z.string().optional(),
})

const RegistryServerSchema = z.object({
  name: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  version: z.string().optional(),
  websiteUrl: z.string().optional(),
  // The publisher's own icons. Lenient by design — a malformed entry must cost
  // an icon, never the whole record — and read here as well as in
  // `registry-icons.ts` so ingestion can persist the best URL for the lazy
  // resolver instead of discarding what the publisher actually declared.
  icons: z.array(z.object({
    mimeType: z.string().optional(),
    sizes: z.union([z.string(), z.array(z.string())]).optional(),
    src: z.string(),
  }).passthrough()).optional(),
  repository: z.object({ url: z.string().optional() }).optional(),
  remotes: z.array(RegistryRemoteSchema).optional(),
})

export const RegistryServerEntrySchema = z.object({
  server: RegistryServerSchema,
  _meta: z.record(z.unknown()).optional(),
})

export const RegistryPageSchema = z.object({
  servers: z.array(z.unknown()),
  metadata: z
    .object({
      nextCursor: z.string().optional(),
      count: z.number().optional(),
    })
    .optional(),
})

export type RegistryPage = z.infer<typeof RegistryPageSchema>
export type RegistryRemote = z.infer<typeof RegistryRemoteSchema>

/**
 * One upstream server, flattened to the fields ingestion reads. This is what
 * gets stored verbatim in `McpCatalogEntry.upstream`, so a re-sync can diff
 * against what the previous sync saw without a second fetch — which is what
 * makes "never overwrite a curator" decidable instead of guessed.
 */
export type RegistryRecord = {
  name: string
  title: string | null
  description: string
  version: string | null
  websiteUrl: string | null
  repositoryUrl: string | null
  /** Publisher-declared icon URLs, unvalidated; the resolver vets them. */
  declaredIconUrls: string[]
  remotes: RegistryRemote[]
  /** Registry lifecycle: `active` | `deprecated` | `deleted`. */
  status: string | null
  isLatest: boolean
  publishedAt: string | null
  updatedAt: string | null
}

export const parseRegistryEntry = (
  value: unknown,
): { ok: true; record: RegistryRecord } | { ok: false; reason: string } => {
  const parsed = RegistryServerEntrySchema.safeParse(value)
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues[0]?.message ?? 'shape mismatch' }
  }
  const { server } = parsed.data
  const meta = RegistryOfficialMetaSchema.safeParse(
    parsed.data._meta?.[REGISTRY_OFFICIAL_META_KEY],
  )
  const official = meta.success ? meta.data : {}
  return {
    ok: true,
    record: {
      name: server.name,
      title: server.title ?? null,
      description: server.description ?? '',
      version: server.version ?? null,
      websiteUrl: server.websiteUrl ?? null,
      repositoryUrl: server.repository?.url ?? null,
      declaredIconUrls: (server.icons ?? []).map((icon) => icon.src),
      remotes: server.remotes ?? [],
      status: official.status ?? null,
      // Absent means the registry did not vouch for this row being current, and
      // an un-vouched row is not ingested. Defaulting to `true` would import
      // every historical version of every server.
      isLatest: official.isLatest === true,
      publishedAt: official.publishedAt ?? null,
      updatedAt: official.updatedAt ?? null,
    },
  }
}

/**
 * Read a stored `upstream` snapshot back. A row written by an older sync may
 * predate a field, so this is lenient in exactly the way `parseRegistryEntry`
 * is not: a snapshot it cannot read yields `null`, and the merge then treats
 * every column as curator-owned — the safe direction.
 */
export const readUpstreamSnapshot = (value: unknown): RegistryRecord | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.name !== 'string' || record.name.length === 0) return null
  const remotes = Array.isArray(record.remotes)
    ? record.remotes.flatMap((remote) => {
      const parsed = RegistryRemoteSchema.safeParse(remote)
      return parsed.success ? [parsed.data] : []
    })
    : []
  const text = (key: string): string | null =>
    typeof record[key] === 'string' ? (record[key] as string) : null
  return {
    name: record.name,
    title: text('title'),
    description: typeof record.description === 'string' ? record.description : '',
    version: text('version'),
    websiteUrl: text('websiteUrl'),
    repositoryUrl: text('repositoryUrl'),
    // A stored snapshot predating icon capture simply has none; the resolver
    // then derives one from the site exactly as it does for every other row.
    declaredIconUrls: Array.isArray(record.declaredIconUrls)
      ? record.declaredIconUrls.filter((src): src is string => typeof src === 'string')
      : [],
    remotes,
    status: text('status'),
    isLatest: record.isLatest === true,
    publishedAt: text('publishedAt'),
    updatedAt: text('updatedAt'),
  }
}
