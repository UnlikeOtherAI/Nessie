import { z } from 'zod'

/**
 * MCP universal client + connector plugin system — type contracts (Slice B).
 *
 * Spec: `docs/external-tool-integration.md` §2/§4, `docs/tool-registry-spec.md`
 * §3.1, and `docs/plans/2026-05-16-mcp-universal-connector.md` §4.
 *
 * These schemas are the authoritative TypeScript contract for the MCP catalog,
 * server instances, and per-principal credential overrides. They mirror the
 * Prisma models defined in `api/prisma/schema.prisma`.
 */

const createUuidBrandSchema = <TBrand extends string>() =>
  z.string().uuid().brand<TBrand>()

// ─── Branded IDs ────────────────────────────────────────────────────────────

export const McpCatalogEntryIdSchema = createUuidBrandSchema<'McpCatalogEntryId'>()
export type McpCatalogEntryId = z.infer<typeof McpCatalogEntryIdSchema>

export const McpServerInstanceIdSchema =
  createUuidBrandSchema<'McpServerInstanceId'>()
export type McpServerInstanceId = z.infer<typeof McpServerInstanceIdSchema>

export const McpServerCredentialOverrideIdSchema =
  createUuidBrandSchema<'McpServerCredentialOverrideId'>()
export type McpServerCredentialOverrideId = z.infer<
  typeof McpServerCredentialOverrideIdSchema
>

export const parseMcpCatalogEntryId = (value: string): McpCatalogEntryId =>
  McpCatalogEntryIdSchema.parse(value)
export const parseMcpServerInstanceId = (value: string): McpServerInstanceId =>
  McpServerInstanceIdSchema.parse(value)
export const parseMcpServerCredentialOverrideId = (
  value: string,
): McpServerCredentialOverrideId =>
  McpServerCredentialOverrideIdSchema.parse(value)

// ─── Enums ──────────────────────────────────────────────────────────────────

export const McpCatalogProtocolSchema = z.enum(['stdio', 'http', 'sse', 'ws'])
export type McpCatalogProtocol = z.infer<typeof McpCatalogProtocolSchema>

export const McpCatalogAuthMethodSchema = z.enum([
  'api_key',
  'bearer',
  'basic',
  'oauth2',
  'none',
])
export type McpCatalogAuthMethod = z.infer<typeof McpCatalogAuthMethodSchema>

export const McpCatalogStatusSchema = z.enum([
  'draft',
  'pending_approval',
  'published',
  'rejected',
  'deprecated',
])
export type McpCatalogStatus = z.infer<typeof McpCatalogStatusSchema>

/**
 * Who can see and install a catalog entry:
 * - `private` — personal connector, visible only to its `ownerUserId`. The
 *   owner self-publishes (`draft` → `published`) and installs it without any
 *   review.
 * - `public` — listed in the shared App Store. Reaching `published` requires a
 *   superuser (the `owner` role) to approve a `pending_approval` submission.
 */
export const McpCatalogVisibilitySchema = z.enum(['private', 'public'])
export type McpCatalogVisibility = z.infer<typeof McpCatalogVisibilitySchema>

export const McpServerScopeTypeSchema = z.enum([
  'system',
  'organization',
  'project',
  'team',
  'channel',
  'user',
])
export type McpServerScopeType = z.infer<typeof McpServerScopeTypeSchema>

export const McpServerLifecycleStateSchema = z.enum([
  'pending_setup',
  'active',
  'paused',
  'error',
])
export type McpServerLifecycleState = z.infer<
  typeof McpServerLifecycleStateSchema
>

export const McpCredentialPrincipalTypeSchema = z.enum([
  'user',
  'agent',
  'channel',
  'team',
  'project',
  'organization',
])
export type McpCredentialPrincipalType = z.infer<
  typeof McpCredentialPrincipalTypeSchema
>

// ─── Auth config (discriminated union per D3/D4) ────────────────────────────

/**
 * Per D4: `api_key` carries a configurable header name and value prefix so
 * each catalog entry can match its vendor's convention (e.g. `Authorization:
 * Bearer …` vs `X-API-Key: <key>` vs `X-Auth-Token: Token <key>`).
 */
export const McpApiKeyAuthConfigSchema = z.object({
  method: z.literal('api_key'),
  headerName: z.string().min(1),
  valuePrefix: z.string(),
})
export type McpApiKeyAuthConfig = z.infer<typeof McpApiKeyAuthConfigSchema>

export const McpBearerAuthConfigSchema = z.object({
  method: z.literal('bearer'),
})
export type McpBearerAuthConfig = z.infer<typeof McpBearerAuthConfigSchema>

export const McpBasicAuthConfigSchema = z.object({
  method: z.literal('basic'),
})
export type McpBasicAuthConfig = z.infer<typeof McpBasicAuthConfigSchema>

/**
 * OAuth2 auth config, two shapes behind one `method`:
 *
 * - **Static** — a pre-registered confidential client per RFC 6749 §2.2 +
 *   §4.1: `authorizationUrl` + `tokenUrl` + `clientId` (+ optional
 *   `clientSecret`; public clients have none). Storing the secret in the
 *   catalog row is acceptable for v1 because the catalog is org-scoped admin
 *   configuration.
 * - **Dynamic** (MCP authorization spec) — `{ method: "oauth2" }` alone. All
 *   endpoints are discovered from the server's RFC 9728/8414 metadata and a
 *   client is minted via Dynamic Client Registration (RFC 7591) at first use.
 *
 * `startOAuth` picks the mode by whether the static fields are present.
 */
export const McpOAuth2AuthConfigSchema = z.object({
  method: z.literal('oauth2'),
  authorizationUrl: z.string().url().optional(),
  tokenUrl: z.string().url().optional(),
  clientId: z.string().min(1).optional(),
  clientSecret: z.string().min(1).optional(),
  scopes: z.array(z.string()).default([]),
  refreshUrl: z.string().url().optional(),
})
export type McpOAuth2AuthConfig = z.infer<typeof McpOAuth2AuthConfigSchema>

export const McpNoneAuthConfigSchema = z.object({
  method: z.literal('none'),
})
export type McpNoneAuthConfig = z.infer<typeof McpNoneAuthConfigSchema>

export const McpServerAuthConfigSchema = z.discriminatedUnion('method', [
  McpApiKeyAuthConfigSchema,
  McpBearerAuthConfigSchema,
  McpBasicAuthConfigSchema,
  McpOAuth2AuthConfigSchema,
  McpNoneAuthConfigSchema,
])
export type McpServerAuthConfig = z.infer<typeof McpServerAuthConfigSchema>

// ─── Transport config ───────────────────────────────────────────────────────

const JsonRecordSchema = z.record(z.string(), z.unknown())

export const McpStdioTransportConfigSchema = z.object({
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
})
export type McpStdioTransportConfig = z.infer<
  typeof McpStdioTransportConfigSchema
>

export const McpHttpTransportConfigSchema = z.object({
  transport: z.literal('http'),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
})
export type McpHttpTransportConfig = z.infer<
  typeof McpHttpTransportConfigSchema
>

export const McpSseTransportConfigSchema = z.object({
  transport: z.literal('sse'),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
})
export type McpSseTransportConfig = z.infer<typeof McpSseTransportConfigSchema>

export const McpWsTransportConfigSchema = z.object({
  transport: z.literal('ws'),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
})
export type McpWsTransportConfig = z.infer<typeof McpWsTransportConfigSchema>

export const McpTransportConfigSchema = z.discriminatedUnion('transport', [
  McpStdioTransportConfigSchema,
  McpHttpTransportConfigSchema,
  McpSseTransportConfigSchema,
  McpWsTransportConfigSchema,
])
export type McpTransportConfig = z.infer<typeof McpTransportConfigSchema>

// ─── Catalog entry ──────────────────────────────────────────────────────────

const OrganizationIdRefSchema = z.string().uuid()
const UserIdRefSchema = z.string().uuid()
const TimestampSchema = z.string().min(1)

export const McpCatalogEntrySchema = z.object({
  id: McpCatalogEntryIdSchema,
  organizationId: OrganizationIdRefSchema.nullable(),
  name: z.string().min(1),
  label: z.string().min(1),
  description: z.string().default(''),
  protocol: McpCatalogProtocolSchema,
  authMethod: McpCatalogAuthMethodSchema,
  authConfig: McpServerAuthConfigSchema,
  defaultTransportConfig: JsonRecordSchema.default({}),
  iconUrl: z.string().url().nullable().optional(),
  vendor: z.string().nullable().optional(),
  sourceUrl: z.string().url().nullable().optional(),
  signature: z.string().nullable().optional(),
  status: McpCatalogStatusSchema.default('draft'),
  visibility: McpCatalogVisibilitySchema.default('private'),
  /** Owner of a `private` entry; `null` for `public` (store-wide) entries. */
  ownerUserId: UserIdRefSchema.nullable(),
  /** When the entry was submitted for public review (`pending_approval`). */
  submittedAt: TimestampSchema.nullable().optional(),
  /** When a superuser approved or rejected the submission. */
  reviewedAt: TimestampSchema.nullable().optional(),
  reviewedBy: UserIdRefSchema.nullable().optional(),
  /** Reason captured when a submission is rejected. */
  rejectionReason: z.string().nullable().optional(),
  createdBy: UserIdRefSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type McpCatalogEntry = z.infer<typeof McpCatalogEntrySchema>

// ─── Server instance ────────────────────────────────────────────────────────

export const McpServerInstanceSchema = z.object({
  id: McpServerInstanceIdSchema,
  catalogEntryId: McpCatalogEntryIdSchema,
  organizationId: OrganizationIdRefSchema,
  scopeType: McpServerScopeTypeSchema,
  scopeId: z.string().uuid(),
  credentialRef: z.string().nullable().optional(),
  transportConfig: JsonRecordSchema.default({}),
  discoveredTools: z.array(JsonRecordSchema).default([]),
  lifecycleState: McpServerLifecycleStateSchema.default('pending_setup'),
  healthLastCheckedAt: TimestampSchema.nullable().optional(),
  healthFailureCount: z.number().int().nonnegative().default(0),
  lastError: z.string().nullable().optional(),
  installedBy: UserIdRefSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type McpServerInstance = z.infer<typeof McpServerInstanceSchema>

// ─── Credential override ────────────────────────────────────────────────────

export const McpServerCredentialOverrideSchema = z.object({
  id: McpServerCredentialOverrideIdSchema,
  instanceId: McpServerInstanceIdSchema,
  principalType: McpCredentialPrincipalTypeSchema,
  principalId: z.string().uuid(),
  credentialRef: z.string().min(1),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type McpServerCredentialOverride = z.infer<
  typeof McpServerCredentialOverrideSchema
>
