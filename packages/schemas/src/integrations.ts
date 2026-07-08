import { z } from 'zod'

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
  name: NonEmptyStringSchema,
  pluginManifestRef: z.string().nullable(),
  setupHint: z.string().nullable(),
  slug: NonEmptyStringSchema,
  sortOrder: z.number().int(),
  summary: z.string(),
  updatedAt: TimestampSchema,
})
export type IntegratedProductResponse = z.infer<typeof IntegratedProductResponseSchema>

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
