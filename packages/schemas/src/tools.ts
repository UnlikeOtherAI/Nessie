import { z } from 'zod'

import {
  McpServerInstanceIdSchema,
} from './mcp.js'
import { ImplementedExecutorOperationKeySchema } from './executor.js'
import { AgentIdSchema } from './ids.js'

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
  'executor',
])
export type ToolRegistrySource = z.infer<typeof ToolRegistrySourceSchema>

export const ToolRegistryTransportSchema = z.enum([
  'direct',
  'mcp',
  'http',
  'stdio',
  'pty',
  'executor',
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

/**
 * Owner review verdict on a discovered MCP tool.
 *
 * A strict subset of `ToolRegistryEntryStatus`: `pending_review` is
 * deliberately absent because only the projection sets it — when a
 * shared-scope install first discovers a tool, or when a re-probe finds an
 * already-approved tool's schema has drifted. A reviewer moves a tool *out* of
 * that state, never back into it, so "pending" always means "the server said
 * something new that nobody has looked at yet".
 *
 * Distinct from `ToolBundleStatusSchema` below, which governs tool *bundles*
 * and has its own approved/rejected vocabulary.
 */
export const ToolReviewVerdictSchema = z.enum(['active', 'disabled'])
export type ToolReviewVerdict = z.infer<typeof ToolReviewVerdictSchema>

/**
 * Bulk review of discovered MCP tools.
 *
 * Ids are explicit rather than "everything matching a filter": one connector
 * routinely projects dozens of tools, some of them destructive, so an approval
 * must only ever cover rows the reviewer actually had on screen. A one-element
 * array is the single-tool case — there is no separate per-tool route.
 */
export const SetToolRegistryStatusRequestSchema = z.object({
  status: ToolReviewVerdictSchema,
  toolRegistryEntryIds: z.array(z.string().uuid()).min(1).max(200),
})
export type SetToolRegistryStatusRequest = z.infer<
  typeof SetToolRegistryStatusRequestSchema
>

export const SetToolRegistryStatusResponseSchema = z.object({
  status: ToolReviewVerdictSchema,
  updatedIds: z.array(z.string().uuid()),
})
export type SetToolRegistryStatusResponse = z.infer<
  typeof SetToolRegistryStatusResponseSchema
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

// ─── Per-agent tool-policy mutation ────────────────────────────────────────

/**
 * Minimal owner-facing agent projection for targeted tool-policy edits.
 *
 * This is deliberately separate from `GET /api/agents`: the ordinary agent
 * list excludes the organization-wide, system-managed Personal Assistant so
 * its private DM bindings and activity never leak into shared agent surfaces.
 * The tool-policy surface needs only identity + policy state.
 */
export const AgentToolPolicyTargetSchema = z.object({
  id: AgentIdSchema,
  agentKind: z.enum(['personal_assistant', 'shared']),
  name: z.string().min(1),
  role: z.string().min(1),
  toolPolicy: z.record(z.string(), z.boolean()),
})
export type AgentToolPolicyTarget = z.infer<typeof AgentToolPolicyTargetSchema>

/**
 * Mutates one registry entry in one agent's policy. `enabled=false` revokes an
 * explicit allow without replacing the rest of the JSON policy.
 */
export const SetAgentToolPolicyEntryRequestSchema = z.object({
  enabled: z.boolean(),
}).strict()
export type SetAgentToolPolicyEntryRequest =
  z.infer<typeof SetAgentToolPolicyEntryRequestSchema>

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

/**
 * The registry records a logical executor operation only. The server resolves
 * and fences the actual executor for the run; callers never supply a machine.
 */
export const ExecutorTransportRegistryConfigSchema = z.object({
  transport: z.literal('executor'),
  operationKey: ImplementedExecutorOperationKeySchema,
}).strict()
export type ExecutorTransportRegistryConfig = z.infer<
  typeof ExecutorTransportRegistryConfigSchema
>

export const ToolTransportConfigSchema = z.discriminatedUnion('transport', [
  DirectTransportConfigSchema,
  McpTransportRegistryConfigSchema,
  HttpTransportRegistryConfigSchema,
  StdioTransportRegistryConfigSchema,
  PtyTransportRegistryConfigSchema,
  ExecutorTransportRegistryConfigSchema,
])
export type ToolTransportConfig = z.infer<typeof ToolTransportConfigSchema>

// ─── ToolRegistryEntry extensions (Slice B + spec §3.1) ─────────────────────

/**
 * `basePrompt` shape per spec §3.1: the merge-mode-tagged prompt block stored
 * on every tool. Roles/agents can override via `commonPrompt` and prompt
 * layers — see `docs/tool-registry-spec.md` §6.
 */
export const PromptMergeModeSchema = z.enum(['append', 'prepend', 'replace'])
export type PromptMergeMode = z.infer<typeof PromptMergeModeSchema>

// NOTE: the `{content:'',mergeMode:'append'}` default below is an
// implementation-chosen seed, not a value mandated by the spec. The spec only
// requires that every row carries a `basePrompt` object; the empty/append seed
// keeps backfills cheap and lets newly created tools omit the field.
export const ToolBasePromptSchema = z.object({
  content: z.string().default(''),
  mergeMode: PromptMergeModeSchema.default('append'),
})
export type ToolBasePrompt = z.infer<typeof ToolBasePromptSchema>

export const ToolCommonPromptSchema = z.object({
  enabledPrompt: z.string(),
  overviewPrompt: z.string().optional(),
  blockedPrompt: z.string().optional(),
  overrideMode: PromptMergeModeSchema,
})
export type ToolCommonPrompt = z.infer<typeof ToolCommonPromptSchema>

/**
 * Slice B + task #10 additions to `ToolRegistryEntry`. Combine with the base
 * entry shape from `index.ts` to get the full row.
 *
 * Backfill defaults applied by the reconcile migration:
 * - `source='builtin'`, `transport='direct'`, `status='active'`
 * - `overview=''`, `instructions=''`, `searchableText=''`, `owner='system'`
 * - `baseSearchTerms=[]`, `allowSearchTerms=[]`, `defaultConfig={}`
 * - `basePrompt={content:'',mergeMode:'append'}`, `commonPrompt=null`
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
  baseSearchTerms: z.array(z.string()).default([]),
  allowSearchTerms: z.array(z.string()).default([]),
  // Implementation-chosen default (not spec-mandated): the spec only requires
  // that every row carries a `basePrompt` object. See `ToolBasePromptSchema`.
  basePrompt: ToolBasePromptSchema.default({
    content: '',
    mergeMode: 'append',
  }),
  commonPrompt: ToolCommonPromptSchema.nullable().optional(),
  defaultConfig: JsonRecordSchema.default({}),
  // Spec §3.1 treats `overview` as a required human-readable summary. No
  // default — callers must supply a non-empty string. Pre-reconcile rows that
  // were backfilled with `''` stay legal at the DB level, but new inserts
  // (Prisma `create` / `upsert.create`) must include this field.
  overview: z.string().min(1),
  instructions: z.string().default(''),
  searchableText: z.string().default(''),
  owner: z.string().min(1).default('system'),
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
