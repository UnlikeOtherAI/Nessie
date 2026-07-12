import { z } from 'zod'

import { NonEmptyStringSchema } from './schema-primitives.js'

// Integration plugin manifest + product-surface schemas. Split out of
// `integrations.ts` (the product/account/usage record schemas) along the
// "how a product declares itself" seam: install modes, the surfaces it weaves
// into the app, and the full plugin manifest. Depends only on `z` and
// `NonEmptyStringSchema`, so it carries no coupling back to the record schemas.

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

// A product surface is a place an activated integration weaves itself into the
// real app. `requires` gates visibility against the live product record from
// `GET /api/integrations/products` (see `useProductSurfaces` on the client).
// The union is additive/optional on the manifest so existing manifests and
// consumers are unaffected.
export const ProductSurfaceRequirementSchema = z.object({
  linked: z.boolean().optional(),
  teamEnabled: z.boolean().optional(),
  capability: NonEmptyStringSchema.optional(),
  connectorActive: z.boolean().optional(),
})
export type ProductSurfaceRequirement =
  z.infer<typeof ProductSurfaceRequirementSchema>

export const ChatAssistantSurfaceSchema = z.object({
  type: z.literal('chat_assistant'),
  channelKind: z.literal('external_agent'),
  productSlug: NonEmptyStringSchema,
  label: NonEmptyStringSchema,
  iconGlyph: z.string().optional(),
  // Function-first one-line identity for the assistant DM (Slack agent-design:
  // lead with what it does). Rendered next to the non-human product glyph in the
  // channel header and empty-state. Optional/additive.
  description: z.string().optional(),
  requires: ProductSurfaceRequirementSchema,
})
export type ChatAssistantSurface = z.infer<typeof ChatAssistantSurfaceSchema>

export const NavPageSurfaceSchema = z.object({
  type: z.literal('nav_page'),
  id: NonEmptyStringSchema,
  label: NonEmptyStringSchema,
  route: NonEmptyStringSchema,
  iconGlyph: z.string().optional(),
  requires: ProductSurfaceRequirementSchema,
})
export type NavPageSurface = z.infer<typeof NavPageSurfaceSchema>

export const DocumentsSectionSurfaceSchema = z.object({
  type: z.literal('documents_section'),
  id: NonEmptyStringSchema,
  label: NonEmptyStringSchema,
  view: NonEmptyStringSchema,
  iconGlyph: z.string().optional(),
  requires: ProductSurfaceRequirementSchema,
})
export type DocumentsSectionSurface = z.infer<typeof DocumentsSectionSurfaceSchema>

export const ProductSurfaceSchema = z.discriminatedUnion('type', [
  ChatAssistantSurfaceSchema,
  NavPageSurfaceSchema,
  DocumentsSectionSurfaceSchema,
])
export type ProductSurface = z.infer<typeof ProductSurfaceSchema>

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
  // Surfaces the product weaves into the real app when active (chat sidebar,
  // left rail + page, Documents section). Optional/additive: manifests without
  // it declare no surfaces and behave exactly as before.
  surfaces: z.array(ProductSurfaceSchema).default([]),
  // Suggested prompts shown on the empty external-agent channel to bootstrap the
  // conversation (Slack agent-design "suggested prompts"; the discovery
  // mechanism). 2–4 entries. Optional/additive — manifests without it show no
  // starters and the empty channel keeps its plain prompt.
  conversationStarters: z.array(NonEmptyStringSchema).min(2).max(4).optional(),
})
export type IntegrationPluginManifest =
  z.infer<typeof IntegrationPluginManifestSchema>
