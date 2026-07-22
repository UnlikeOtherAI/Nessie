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

// DeepSignal Signals page (surface-registry plan §4). The Signals route calls
// the product's `insight_digest` MCP tool through the user's user-scoped
// instance and returns the digest as typed records; `insight_act` proxies a
// done/snooze/mute/reopen action back. Fail-closed: when the connector is not
// installed / signed in for the user the route returns `needs_setup` (not a
// fabricated list), which the page renders as a "Connect DeepSignal" empty
// state.
export const DeepSignalSignalStatusSchema = z.enum([
  'active',
  'done',
  'snoozed',
  'muted',
])
export type DeepSignalSignalStatus = z.infer<typeof DeepSignalSignalStatusSchema>

export const DeepSignalSignalKindSchema = z.enum(['opportunity', 'risk', 'signal'])
export type DeepSignalSignalKind = z.infer<typeof DeepSignalSignalKindSchema>

export const DeepSignalSignalRecordSchema = z.object({
  id: NonEmptyStringSchema,
  headline: NonEmptyStringSchema,
  summary: z.string(),
  status: DeepSignalSignalStatusSchema,
  kind: DeepSignalSignalKindSchema.nullable(),
  actionIds: z.array(NonEmptyStringSchema),
  deepLink: z.string().url().nullable(),
  surfacedAt: TimestampSchema.nullable(),
})
export type DeepSignalSignalRecord = z.infer<typeof DeepSignalSignalRecordSchema>

export const DeepSignalSignalsResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    items: z.array(DeepSignalSignalRecordSchema),
  }),
  z.object({ status: z.literal('needs_setup') }),
])
export type DeepSignalSignalsResponse =
  z.infer<typeof DeepSignalSignalsResponseSchema>

export const DeepSignalSignalActionSchema = z.enum([
  'done',
  'snooze',
  'mute',
  'reopen',
])
export type DeepSignalSignalAction = z.infer<typeof DeepSignalSignalActionSchema>

export const DeepSignalSignalActRequestSchema = z.object({
  action: DeepSignalSignalActionSchema,
})
export type DeepSignalSignalActRequest =
  z.infer<typeof DeepSignalSignalActRequestSchema>

export const DeepSignalSignalActResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    item: DeepSignalSignalRecordSchema.nullable(),
  }),
  z.object({ status: z.literal('needs_setup') }),
])
export type DeepSignalSignalActResponse =
  z.infer<typeof DeepSignalSignalActResponseSchema>

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
  title: z.string().trim().max(200).optional(),
})
export type DeepWaterResearchLaunchRequest =
  z.infer<typeof DeepWaterResearchLaunchRequestSchema>

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
})
export type IntegrationUiCard = z.infer<typeof IntegrationUiCardSchema>
