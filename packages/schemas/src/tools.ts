import { z } from 'zod'

import {
  McpServerInstanceIdSchema,
} from './mcp.js'

/**
 * Tool registry contracts for the MCP universal connector (Slice B).
 *
 * Spec: `docs/tool-registry-spec.md` §3.1/§3.2 and
 * `docs/plans/2026-05-16-mcp-universal-connector.md` §4.
 *
 * This module owns:
 * - Branded IDs: `ToolId`, `ToolBundleId`, `ToolGrantId`.
 * - `ToolBundleSchema`, `ToolGrantSchema`.
 * - The Slice B *extensions* to `ToolRegistryEntry`: source/transport/
 *   transportConfig/bundleId/mcpInstanceId/inputSchema/outputSchema/tags/
 *   status/version/createdBy. The base CRUD-side `ToolRegistryEntry` lives in
 *   `packages/schemas/src/index.ts` and `api/src/contracts.ts`; this module
 *   does not re-declare those fields.
 */

const createUuidBrandSchema = <TBrand extends string>() =>
  z.string().uuid().brand<TBrand>()

const TimestampSchema = z.string().min(1)
const JsonRecordSchema = z.record(z.string(), z.unknown())

// ─── Branded IDs ────────────────────────────────────────────────────────────

export const ToolIdSchema = createUuidBrandSchema<'ToolId'>()
export type ToolId = z.infer<typeof ToolIdSchema>

export const ToolBundleIdSchema = createUuidBrandSchema<'ToolBundleId'>()
export type ToolBundleId = z.infer<typeof ToolBundleIdSchema>

export const ToolGrantIdSchema = createUuidBrandSchema<'ToolGrantId'>()
export type ToolGrantId = z.infer<typeof ToolGrantIdSchema>

export const parseToolId = (value: string): ToolId => ToolIdSchema.parse(value)
export const parseToolBundleId = (value: string): ToolBundleId =>
  ToolBundleIdSchema.parse(value)
export const parseToolGrantId = (value: string): ToolGrantId =>
  ToolGrantIdSchema.parse(value)

// ─── Enums ──────────────────────────────────────────────────────────────────

export const ToolRegistrySourceSchema = z.enum([
  'builtin',
  'custom',
  'mcp-remote',
  'interactive-session',
])
export type ToolRegistrySource = z.infer<typeof ToolRegistrySourceSchema>

export const ToolRegistryTransportSchema = z.enum([
  'direct',
  'mcp',
  'http',
  'stdio',
  'pty',
])
export type ToolRegistryTransport = z.infer<typeof ToolRegistryTransportSchema>

export const ToolRegistryEntryStatusSchema = z.enum([
  'active',
  'pending_review',
  'disabled',
])
export type ToolRegistryEntryStatus = z.infer<
  typeof ToolRegistryEntryStatusSchema
>

export const ToolBundleStatusSchema = z.enum([
  'pending_review',
  'approved',
  'rejected',
  'disabled',
])
export type ToolBundleStatus = z.infer<typeof ToolBundleStatusSchema>

export const ToolGrantStateSchema = z.enum(['inherit', 'allowed', 'denied'])
export type ToolGrantState = z.infer<typeof ToolGrantStateSchema>

export const ToolGrantSourceSchema = z.enum(['role', 'agent-override'])
export type ToolGrantSource = z.infer<typeof ToolGrantSourceSchema>

// ─── Transport config (per ToolRegistryEntry.transport) ─────────────────────

/**
 * `transportConfig` shape is union-typed by `transport`. The runtime dispatcher
 * (Slice C/F) keys off this to choose a handler.
 */
export const DirectTransportConfigSchema = z.object({
  transport: z.literal('direct'),
  handler: z.string().min(1),
})
export type DirectTransportConfig = z.infer<typeof DirectTransportConfigSchema>

export const McpTransportRegistryConfigSchema = z.object({
  transport: z.literal('mcp'),
  serverId: McpServerInstanceIdSchema,
  toolName: z.string().min(1),
})
export type McpTransportRegistryConfig = z.infer<
  typeof McpTransportRegistryConfigSchema
>

export const HttpTransportRegistryConfigSchema = z.object({
  transport: z.literal('http'),
  endpointId: z.string().min(1),
})
export type HttpTransportRegistryConfig = z.infer<
  typeof HttpTransportRegistryConfigSchema
>

export const StdioTransportRegistryConfigSchema = z.object({
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
})
export type StdioTransportRegistryConfig = z.infer<
  typeof StdioTransportRegistryConfigSchema
>

export const PtyTransportRegistryConfigSchema = z.object({
  transport: z.literal('pty'),
  sessionId: z.string().min(1),
})
export type PtyTransportRegistryConfig = z.infer<
  typeof PtyTransportRegistryConfigSchema
>

export const ToolTransportConfigSchema = z.discriminatedUnion('transport', [
  DirectTransportConfigSchema,
  McpTransportRegistryConfigSchema,
  HttpTransportRegistryConfigSchema,
  StdioTransportRegistryConfigSchema,
  PtyTransportRegistryConfigSchema,
])
export type ToolTransportConfig = z.infer<typeof ToolTransportConfigSchema>

// ─── ToolRegistryEntry extensions (Slice B) ─────────────────────────────────

/**
 * Slice B additions to `ToolRegistryEntry`. Combine with the base entry shape
 * from `index.ts` to get the full row. Migration backfills these for existing
 * rows: `source='builtin'`, `transport='direct'`, `status='active'`.
 */
export const ToolRegistryEntryExtensionsSchema = z.object({
  source: ToolRegistrySourceSchema,
  transport: ToolRegistryTransportSchema,
  transportConfig: JsonRecordSchema.default({}),
  bundleId: ToolBundleIdSchema.nullable().optional(),
  mcpInstanceId: McpServerInstanceIdSchema.nullable().optional(),
  inputSchema: JsonRecordSchema.default({}),
  outputSchema: JsonRecordSchema.nullable().optional(),
  tags: z.array(z.string()).default([]),
  status: ToolRegistryEntryStatusSchema.default('active'),
  version: z.string().default('0.0.0'),
  createdBy: z.string().min(1).default('system'),
})
export type ToolRegistryEntryExtensions = z.infer<
  typeof ToolRegistryEntryExtensionsSchema
>

// ─── ToolBundle ─────────────────────────────────────────────────────────────

const OrganizationIdRefSchema = z.string().uuid()
const UserIdRefSchema = z.string().uuid()

export const ToolBundleSchema = z.object({
  id: ToolBundleIdSchema,
  organizationId: OrganizationIdRefSchema,
  apiVersion: z.string().min(1),
  bundleName: z.string().min(1),
  version: z.string().min(1),
  vendor: z.string().nullable().optional(),
  sourceUrl: z.string().url().nullable().optional(),
  license: z.string().nullable().optional(),
  signatureType: z.string().nullable().optional(),
  signatureValue: z.string().nullable().optional(),
  policy: JsonRecordSchema.default({}),
  status: ToolBundleStatusSchema.default('pending_review'),
  importedBy: UserIdRefSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type ToolBundle = z.infer<typeof ToolBundleSchema>

// ─── ToolGrant ──────────────────────────────────────────────────────────────

/**
 * `ToolGrant` rows are scoped either to a role or to an agent (never both —
 * see partial unique indexes in `tool-registry-spec.md` §3.1). The schema
 * encodes the structural fields; the (roleId XOR agentId) constraint is
 * enforced at the API layer in Slice C and via partial unique indexes in
 * Postgres.
 */
export const ToolGrantSchema = z.object({
  id: ToolGrantIdSchema,
  toolId: ToolIdSchema,
  state: ToolGrantStateSchema.default('inherit'),
  config: JsonRecordSchema.default({}),
  source: ToolGrantSourceSchema,
  roleId: z.string().uuid().nullable().optional(),
  agentId: z.string().uuid().nullable().optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type ToolGrant = z.infer<typeof ToolGrantSchema>
