import { z } from 'zod'

import {
  McpServerLifecycleStateSchema,
  McpServerScopeTypeSchema,
} from './mcp.js'
import { NonEmptyStringSchema, TimestampSchema } from './schema-primitives.js'

export const IntegratedProductCategorySchema = z.enum([
  'research',
  'security',
  'development',
  'project_management',
])
export type IntegratedProductCategory = z.infer<typeof IntegratedProductCategorySchema>

export const IntegratedProductAuthModeSchema = z.enum([
  'uoa_sso',
  'api_key',
  'oauth_mcp',
  'local_mcp',
])
export type IntegratedProductAuthMode = z.infer<typeof IntegratedProductAuthModeSchema>

export const IntegratedProductInstallStateSchema = z.enum([
  'link_only',
  'installable',
  'native',
])
export type IntegratedProductInstallState = z.infer<typeof IntegratedProductInstallStateSchema>

export const IntegratedProductHealthStatusSchema = z.enum([
  'unknown',
  'healthy',
  'degraded',
  'unreachable',
  'setup_required',
])
export type IntegratedProductHealthStatus = z.infer<typeof IntegratedProductHealthStatusSchema>

export const ProductAccountLinkStatusSchema = z.enum([
  'linked',
  'needs_auth',
  'revoked',
  'error',
])
export type ProductAccountLinkStatus = z.infer<typeof ProductAccountLinkStatusSchema>

export const ProductTeamEnablementAuthoritySchema = z.enum([
  'nessie_projection',
  'uoa_connected_products',
])
export type ProductTeamEnablementAuthority =
  z.infer<typeof ProductTeamEnablementAuthoritySchema>

export const ProductAccountLinkRecordSchema = z.object({
  id: z.string().uuid(),
  activeOrgId: z.string().nullable(),
  activeTeamId: z.string().nullable(),
  externalAccountId: z.string().nullable(),
  lastVerifiedAt: TimestampSchema.nullable(),
  metadata: z.record(z.string(), z.unknown()),
  organizationId: z.string().uuid(),
  productSlug: NonEmptyStringSchema,
  status: ProductAccountLinkStatusSchema,
  uoaSub: z.string().nullable(),
  userId: z.string().uuid(),
})
export type ProductAccountLinkRecord = z.infer<typeof ProductAccountLinkRecordSchema>

export const ProductTeamEnablementRecordSchema = z.object({
  id: z.string().uuid(),
  authority: ProductTeamEnablementAuthoritySchema,
  configuredByUserId: z.string().uuid().nullable(),
  createdAt: TimestampSchema,
  enabled: z.boolean(),
  externalOrgId: z.string().nullable(),
  externalTeamId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  organizationId: z.string().uuid(),
  productSlug: NonEmptyStringSchema,
  teamId: z.string().uuid(),
  updatedAt: TimestampSchema,
})
export type ProductTeamEnablementRecord =
  z.infer<typeof ProductTeamEnablementRecordSchema>

export const ProductMcpInstallationRecordSchema = z.object({
  id: z.string().uuid(),
  catalogEntryId: z.string().uuid(),
  createdAt: TimestampSchema,
  healthFailureCount: z.number().int().nonnegative(),
  healthLastCheckedAt: TimestampSchema.nullable(),
  lastError: z.string().nullable(),
  lifecycleState: McpServerLifecycleStateSchema,
  scopeId: z.string().uuid(),
  scopeType: McpServerScopeTypeSchema,
  toolCount: z.number().int().nonnegative(),
  updatedAt: TimestampSchema,
})
export type ProductMcpInstallationRecord =
  z.infer<typeof ProductMcpInstallationRecordSchema>

export const ProductIntegrationRunStatusSchema = z.enum([
  'queued',
  'running',
  'needs_setup',
  'completed',
  'failed',
  'warning',
])
export type ProductIntegrationRunStatus =
  z.infer<typeof ProductIntegrationRunStatusSchema>

export const DeepWaterResearchRunRecordSchema = z.object({
  id: z.string().uuid(),
  artifactDestination: z.enum(['knowledge_draft', 'chat_only']),
  channelId: z.string().uuid().nullable(),
  completedAt: TimestampSchema.nullable(),
  connectorId: z.string().uuid().nullable(),
  createdAt: TimestampSchema,
  depth: z.enum([
    'light',
    'standard',
    'deep',
    'heavy',
    'thesis',
    'dissertation',
  ]),
  externalRunId: z.string().nullable(),
  knowledgePageId: z.string().uuid().nullable(),
  messageId: z.string().uuid().nullable(),
  organizationId: z.string().uuid(),
  outputTier: z.enum(['summary', 'full']),
  productSlug: z.literal('deep-water'),
  queryPreview: z.string(),
  reportUrl: z.string().url().nullable(),
  requestedAt: TimestampSchema,
  requestedByUserId: z.string().uuid().nullable(),
  searchQuality: z.enum(['standard', 'premium']),
  sourceCount: z.number().int().nonnegative().nullable(),
  status: ProductIntegrationRunStatusSchema,
  statusDetail: z.string().nullable(),
  teamId: z.string().uuid(),
  threadId: z.string().uuid().nullable(),
  title: z.string().nullable(),
  updatedAt: TimestampSchema,
})
export type DeepWaterResearchRunRecord =
  z.infer<typeof DeepWaterResearchRunRecordSchema>

export const DeepSignalSignalKindSchema = z.enum(['opportunity', 'risk', 'signal'])
export type DeepSignalSignalKind = z.infer<typeof DeepSignalSignalKindSchema>

/**
 * `deepsignal.insight.fanout` queue job — one verified `insight.surfaced`
 * webhook delivery, already authenticated and routed to its organisation.
 *
 * The receiver (`POST /api/integrations/deepsignal/events`) verifies the HMAC,
 * resolves the signing organisation and the payload's enabled team, and then
 * enqueues; the recipient fan-out — a channel, a thread, a binding and a digest
 * transaction *per linked team member* — runs here. It used to run inline, so
 * one insight for a fifty-person team held the request open across fifty digest
 * transactions and an instance recycled mid-fan-out lost the rest of them after
 * the caller had already been told 2xx
 * (docs/standards/horizontal-scaling.md § 3; audit 9.2).
 *
 * `insightId` is lifted out of the payload because it is the idempotency key
 * (`deepsignal-insight:<organizationId>:<insightId>`) and the receiver refuses a
 * body without one. Replay is safe without relying on that key: the digest
 * writer holds a per-thread advisory lock and answers an insight already
 * recorded on a live digest with `duplicate`, writing nothing.
 */
export const DEEPSIGNAL_INSIGHT_FANOUT_TOPIC = 'deepsignal.insight.fanout'

export const DeepSignalInsightFanoutJobPayloadSchema = z.object({
  insightId: NonEmptyStringSchema,
  organizationId: z.string().uuid(),
  payload: z.record(z.unknown()),
})
export type DeepSignalInsightFanoutJobPayload =
  z.infer<typeof DeepSignalInsightFanoutJobPayloadSchema>

export const IntegratedProductResponseSchema = z.object({
  id: z.string().uuid(),
  accountLink: ProductAccountLinkRecordSchema.nullable(),
  apiBaseUrl: z.string().nullable(),
  authMode: IntegratedProductAuthModeSchema,
  capabilities: z.array(NonEmptyStringSchema),
  category: IntegratedProductCategorySchema,
  createdAt: TimestampSchema,
  defaultInstallState: IntegratedProductInstallStateSchema,
  healthDetail: z.string().nullable(),
  healthStatus: IntegratedProductHealthStatusSchema,
  launchUrl: z.string().nullable(),
  mcpCatalogEntryId: z.string().uuid().nullable(),
  mcpInstallation: ProductMcpInstallationRecordSchema.nullable(),
  name: NonEmptyStringSchema,
  pluginManifestRef: z.string().nullable(),
  setupHint: z.string().nullable(),
  slug: NonEmptyStringSchema,
  sortOrder: z.number().int(),
  summary: z.string(),
  teamEnablement: ProductTeamEnablementRecordSchema.nullable(),
  updatedAt: TimestampSchema,
})
export type IntegratedProductResponse = z.infer<typeof IntegratedProductResponseSchema>

export const SetProductTeamEnablementRequestSchema = z.object({
  enabled: z.boolean(),
})
export type SetProductTeamEnablementRequest =
  z.infer<typeof SetProductTeamEnablementRequestSchema>

export const DeepWaterAgentAccessTargetSchema = z.object({
  agentId: z.string().uuid(),
  agentKind: z.enum(['personal_assistant', 'shared']),
  enabled: z.boolean(),
  grantedToolCount: z.number().int().nonnegative(),
  name: NonEmptyStringSchema,
  revocableGrantCount: z.number().int().nonnegative(),
  requiredToolCount: z.number().int().positive(),
  role: NonEmptyStringSchema,
})
export type DeepWaterAgentAccessTarget =
  z.infer<typeof DeepWaterAgentAccessTargetSchema>

export const DeepWaterAgentAccessResponseSchema = z.object({
  configured: z.boolean(),
  personalAssistant: DeepWaterAgentAccessTargetSchema.nullable(),
  requiredToolCount: z.number().int().positive(),
  sharedAgents: z.array(DeepWaterAgentAccessTargetSchema),
})
export type DeepWaterAgentAccessResponse =
  z.infer<typeof DeepWaterAgentAccessResponseSchema>

export const SetDeepWaterAgentAccessRequestSchema = z.discriminatedUnion('target', [
  z.object({
    enabled: z.boolean(),
    target: z.literal('personal_assistant'),
  }).strict(),
  z.object({
    agentId: z.string().uuid(),
    enabled: z.boolean(),
    target: z.literal('agent'),
  }).strict(),
])
export type SetDeepWaterAgentAccessRequest =
  z.infer<typeof SetDeepWaterAgentAccessRequestSchema>

export const DeepWaterResearchDepthSchema = z.enum([
  'light',
  'standard',
  'deep',
  'heavy',
  'thesis',
  'dissertation',
])
export type DeepWaterResearchDepth =
  z.infer<typeof DeepWaterResearchDepthSchema>

// No title is asked for or accepted: the research question is the whole ask,
// and a report's own name belongs to DeepWater rather than to whoever typed the
// prompt. Existing rows keep the titles they were launched with; new runs are
// identified by their query preview until DeepWater supplies a report title.
export const DeepWaterResearchLaunchRequestSchema = z.object({
  artifactDestination: z.enum(['knowledge_draft', 'chat_only']).default('knowledge_draft'),
  chapterDepth: z.enum(['brief', 'standard', 'detailed', 'exhaustive']).default('standard'),
  depth: DeepWaterResearchDepthSchema.default('standard'),
  outputLanguage: z.string().trim().min(2).max(12).default('en'),
  outputTier: z.enum(['summary', 'full']).default('full'),
  query: z.string().trim().min(1).max(5_000),
  recency: z.enum(['any', 'day', 'week', 'month', 'year']).default('any'),
  searchQuality: z.enum(['standard', 'premium']).default('standard'),
  searchesPerPillar: z.number().int().min(1).max(20).default(4),
  sections: z.number().int().min(3).max(20).default(8),
})
export type DeepWaterResearchLaunchRequest =
  z.infer<typeof DeepWaterResearchLaunchRequestSchema>

// A chat card can ask the client to open the native DeepWater launcher. Its
// preset is intentionally bounded to the same safe controls as a manual
// launch, but every field is optional so a conversation can prefill only the
// choices it has already established with the user.
export const DeepWaterResearchLauncherPresetSchema = z.object({
  artifactDestination: z.enum(['knowledge_draft', 'chat_only']).optional(),
  chapterDepth: z.enum(['brief', 'standard', 'detailed', 'exhaustive']).optional(),
  depth: DeepWaterResearchDepthSchema.optional(),
  outputLanguage: z.string().trim().min(2).max(12).optional(),
  outputTier: z.enum(['summary', 'full']).optional(),
  query: z.string().trim().min(1).max(5_000).optional(),
  recency: z.enum(['any', 'day', 'week', 'month', 'year']).optional(),
  searchQuality: z.enum(['standard', 'premium']).optional(),
  searchesPerPillar: z.number().int().min(1).max(20).optional(),
  sections: z.number().int().min(3).max(20).optional(),
  // Tolerated, never used. Cards authored before titles were dropped carry one
  // in their stored message metadata, and this schema is strict — rejecting the
  // key would stop those older chat cards rendering at all. New cards omit it
  // and the launcher ignores it.
  title: z.string().trim().max(200).optional(),
}).strict()
export type DeepWaterResearchLauncherPreset =
  z.infer<typeof DeepWaterResearchLauncherPresetSchema>

export const DeepTestReviewDepthSchema = z.enum([
  'shallow',
  'standard',
  'deep',
  'overnight',
])
export type DeepTestReviewDepth =
  z.infer<typeof DeepTestReviewDepthSchema>

export const DeepTestReviewHandoffRequestSchema = z.object({
  artifactPolicy: z.enum(['share_safe_report', 'external_link_only']).default('share_safe_report'),
  depth: DeepTestReviewDepthSchema.default('standard'),
  runner: z.enum(['local_mcp', 'private_runner']).default('local_mcp'),
}).strict()
export type DeepTestReviewHandoffRequest =
  z.infer<typeof DeepTestReviewHandoffRequestSchema>

export const BuildMeProjectHandoffIntentSchema = z.enum([
  'project_definition',
  'development_workspace',
  'board_source_discovery',
])
export type BuildMeProjectHandoffIntent =
  z.infer<typeof BuildMeProjectHandoffIntentSchema>

export const BuildMeProjectHandoffRequestSchema = z.object({
  contextScope: z.enum(['active_project', 'active_team']).default('active_project'),
  intent: BuildMeProjectHandoffIntentSchema.default('project_definition'),
}).strict()
export type BuildMeProjectHandoffRequest =
  z.infer<typeof BuildMeProjectHandoffRequestSchema>

export const IntegrationUiCardStatusSchema = z.enum([
  'idle',
  'queued',
  'running',
  'needs_setup',
  'completed',
  'failed',
  'warning',
])
export type IntegrationUiCardStatus = z.infer<typeof IntegrationUiCardStatusSchema>

export const IntegrationUiCardActionSchema = z.object({
  label: NonEmptyStringSchema,
  href: z.string().min(1).optional(),
  type: z.enum(['link', 'open_deep_water_research_launcher']).default('link'),
  preset: DeepWaterResearchLauncherPresetSchema.optional(),
  variant: z.enum(['primary', 'secondary']).optional(),
})
export type IntegrationUiCardAction = z.infer<typeof IntegrationUiCardActionSchema>

export const IntegrationUiCardFieldSchema = z.object({
  label: NonEmptyStringSchema,
  value: NonEmptyStringSchema,
})
export type IntegrationUiCardField = z.infer<typeof IntegrationUiCardFieldSchema>

export const IntegrationUiCardSchema = z.object({
  kind: z.enum(['integration', 'deep_research', 'security_review', 'project_board']),
  productSlug: NonEmptyStringSchema.optional(),
  // Distinguishes a narrated reasoning step ('activity') from a result card
  // ('result') so an external-agent assistant turn can render its activities as
  // a collapsed plan/timeline while result cards stay flat. Additive/optional:
  // producers that omit it (and every non-external card) render as flat cards.
  role: z.enum(['activity', 'result']).optional(),
  title: NonEmptyStringSchema,
  status: IntegrationUiCardStatusSchema,
  summary: z.string().optional(),
  fields: z.array(IntegrationUiCardFieldSchema).optional(),
  actions: z.array(IntegrationUiCardActionSchema).optional(),
}).superRefine((card, context) => {
  if (
    card.actions?.some((action) => action.type === 'open_deep_water_research_launcher')
    && card.productSlug !== 'deep-water'
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Only Deep Water cards can open the Deep Water research launcher.',
      path: ['actions'],
    })
  }
})
export type IntegrationUiCard = z.infer<typeof IntegrationUiCardSchema>
