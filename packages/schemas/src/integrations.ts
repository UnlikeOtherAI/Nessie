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

export const ProductUsageSummaryRecordSchema = z.object({
  currency: NonEmptyStringSchema,
  failureCount: z.number().int().nonnegative(),
  lastOperation: z.string().nullable(),
  lastUsedAt: TimestampSchema.nullable(),
  monthStart: TimestampSchema,
  successCount: z.number().int().nonnegative(),
  totalCalls: z.number().int().nonnegative(),
  totalCost: z.number().nonnegative(),
  totalUnits: z.number().int().nonnegative(),
})
export type ProductUsageSummaryRecord =
  z.infer<typeof ProductUsageSummaryRecordSchema>

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
  currency: NonEmptyStringSchema.nullable(),
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
  totalCost: z.number().nonnegative().nullable(),
  updatedAt: TimestampSchema,
})
export type DeepWaterResearchRunRecord =
  z.infer<typeof DeepWaterResearchRunRecordSchema>

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
  usageSummary: ProductUsageSummaryRecordSchema,
})
export type IntegratedProductResponse = z.infer<typeof IntegratedProductResponseSchema>

export const SetProductTeamEnablementRequestSchema = z.object({
  enabled: z.boolean(),
})
export type SetProductTeamEnablementRequest =
  z.infer<typeof SetProductTeamEnablementRequestSchema>

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
  title: NonEmptyStringSchema,
  status: IntegrationUiCardStatusSchema,
  summary: z.string().optional(),
  fields: z.array(IntegrationUiCardFieldSchema).optional(),
  actions: z.array(IntegrationUiCardActionSchema).optional(),
})
export type IntegrationUiCard = z.infer<typeof IntegrationUiCardSchema>

export const IntegrationPluginInstallModeSchema = z.enum([
  'hosted_preinstall',
  'remote_mcp_oauth',
  'api_key',
  'local_mcp',
  'link_out',
  'native_data_source',
])
export type IntegrationPluginInstallMode =
  z.infer<typeof IntegrationPluginInstallModeSchema>

export const IntegrationPluginAvailabilitySchema = z.enum([
  'hosted',
  'self_hosted',
  'both',
])
export type IntegrationPluginAvailability =
  z.infer<typeof IntegrationPluginAvailabilitySchema>

export const IntegrationPluginSurfaceStatusSchema = z.enum([
  'available',
  'planned',
  'blocked',
])
export type IntegrationPluginSurfaceStatus =
  z.infer<typeof IntegrationPluginSurfaceStatusSchema>

export const IntegrationPluginPrivacyTierSchema = z.enum([
  'normal',
  'sensitive',
  'restricted',
  'local_only',
])
export type IntegrationPluginPrivacyTier =
  z.infer<typeof IntegrationPluginPrivacyTierSchema>

export const IntegrationPluginManifestSchema = z.object({
  apiVersion: z.literal('integrations.nessie.io/v1'),
  kind: z.literal('NessieIntegrationPlugin'),
  manifestRef: NonEmptyStringSchema,
  productSlug: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  version: NonEmptyStringSchema,
  vendor: NonEmptyStringSchema,
  install: z.array(z.object({
    mode: IntegrationPluginInstallModeSchema,
    availability: IntegrationPluginAvailabilitySchema,
    label: NonEmptyStringSchema,
    requiredForAgentUse: z.boolean(),
    setup: NonEmptyStringSchema,
  })).min(1),
  mcp: z.object({
    catalogTemplate: z.object({
      name: NonEmptyStringSchema,
      label: NonEmptyStringSchema,
      protocol: z.enum(['stdio', 'http', 'sse', 'ws']),
      authMethod: z.enum(['api_key', 'bearer', 'basic', 'oauth2', 'none']),
      transport: z.record(z.string(), z.unknown()),
      auth: z.record(z.string(), z.unknown()),
    }).nullable(),
    toolBundleRef: z.string().nullable(),
    tools: z.array(z.object({
      name: NonEmptyStringSchema,
      label: NonEmptyStringSchema,
      description: NonEmptyStringSchema,
      privacyTier: IntegrationPluginPrivacyTierSchema,
      status: IntegrationPluginSurfaceStatusSchema,
    })),
  }),
  ui: z.object({
    pages: z.array(z.object({
      id: NonEmptyStringSchema,
      label: NonEmptyStringSchema,
      status: IntegrationPluginSurfaceStatusSchema,
    })),
    cards: z.array(z.object({
      kind: z.enum(['integration', 'deep_research', 'security_review', 'project_board']),
      label: NonEmptyStringSchema,
      status: IntegrationPluginSurfaceStatusSchema,
    })),
    controls: z.array(z.object({
      id: NonEmptyStringSchema,
      label: NonEmptyStringSchema,
      status: IntegrationPluginSurfaceStatusSchema,
    })),
  }),
  artifacts: z.array(z.object({
    kind: NonEmptyStringSchema,
    label: NonEmptyStringSchema,
    defaultDestination: NonEmptyStringSchema,
    fileServiceRequired: z.boolean(),
  })),
  privacy: z.object({
    dataBoundary: NonEmptyStringSchema,
    defaultImportPolicy: NonEmptyStringSchema,
    prohibitedByDefault: z.array(NonEmptyStringSchema),
  }),
  usage: z.object({
    ledger: z.enum(['connector_usage_events', 'token_ledger_events', 'none']),
    connectorType: z.enum([
      'mcp',
      'http',
      'web_search',
      'web_fetch',
      'storage',
      'push',
      'github',
      'oauth',
      'other',
    ]).nullable(),
    costFields: z.array(NonEmptyStringSchema),
  }),
})
export type IntegrationPluginManifest =
  z.infer<typeof IntegrationPluginManifestSchema>
