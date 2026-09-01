import { z } from 'zod'

import { AppAuthMethodSchema, AppTrustLevelSchema } from './apps.js'
import { NonEmptyStringSchema, TimestampSchema } from './schema-primitives.js'

/**
 * The state machine for a connection a person approves from an agent-authored
 * chat card. This belongs to app setup only; executor setup has a separate
 * model and must not add states here.
 */
export const AgentAppConnectionRequestStatusSchema = z.enum([
  'offered',
  'connecting',
  'needs_secret',
  'selecting_resources',
  'awaiting_scope_upgrade',
  'awaiting_grant',
  'ready',
  'failed',
  'cancelled',
  'expired',
  'superseded',
])
export type AgentAppConnectionRequestStatus = z.infer<
  typeof AgentAppConnectionRequestStatusSchema
>

export const AgentAppConnectionBackendSchema = z.enum(['mcp', 'comms_google'])
export type AgentAppConnectionBackend = z.infer<typeof AgentAppConnectionBackendSchema>

/** The scopes an App setup card may offer; system/project scope is never inferred. */
export const AppConnectionRequestScopeTypeSchema = z.enum([
  'user',
  'organization',
  'team',
  'channel',
])
export type AppConnectionRequestScopeType = z.infer<
  typeof AppConnectionRequestScopeTypeSchema
>

/**
 * The entire durable payload stored on an assistant message. The request id is
 * an opaque pointer: mutable status, app details, account information and all
 * actions are loaded from the authenticated request presenter.
 */
export const AppSetupCardSchema = z.object({
  card: z.object({
    kind: z.literal('app_connect_request'),
    requestId: z.string().uuid(),
    schemaVersion: z.literal(1),
  }).strict(),
}).strict()
export type AppSetupCard = z.infer<typeof AppSetupCardSchema>

/** Input accepted from the model by the presentation-only request tool. */
export const AppConnectRequestToolInputSchema = z.object({
  candidateCatalogEntryIds: z.array(z.string().uuid()).min(1).max(3),
  reason: z.string().trim().min(1).max(500),
}).strict()
export type AppConnectRequestToolInput = z.infer<typeof AppConnectRequestToolInputSchema>

/**
 * Server-derived candidate presentation. It intentionally excludes endpoint,
 * transport configuration, authorization links and credential information.
 */
export const AppSetupCardCandidateSchema = z.object({
  authMethod: AppAuthMethodSchema,
  capabilityCount: z.number().int().nonnegative().nullable(),
  catalogEntryId: z.string().uuid(),
  displayName: NonEmptyStringSchema,
  iconUrl: z.string().nullable(),
  trustLevel: AppTrustLevelSchema,
}).strict()
export type AppSetupCardCandidate = z.infer<typeof AppSetupCardCandidateSchema>

export const AppSetupCardScopeSchema = z.object({
  label: NonEmptyStringSchema,
  scopeType: AppConnectionRequestScopeTypeSchema,
}).strict()
export type AppSetupCardScope = z.infer<typeof AppSetupCardScopeSchema>

/**
 * Viewer-scoped state for rendering the card. This is not message metadata:
 * only the target user receives actionable controls. The schema purposefully
 * has no authorization URL, backing instance id, account identity or secret.
 */
export const AppSetupCardPresenterSchema = z.object({
  action: z.enum(['begin', 'none']),
  agent: z.object({
    id: z.string().uuid(),
    name: NonEmptyStringSchema,
  }).strict(),
  candidates: z.array(AppSetupCardCandidateSchema).min(1).max(3),
  detail: z.string().max(500).nullable(),
  expiresAt: TimestampSchema,
  failureCode: z.string().max(100).nullable(),
  requestId: z.string().uuid(),
  scope: AppSetupCardScopeSchema.nullable(),
  selectedCatalogEntryId: z.string().uuid().nullable(),
  status: AgentAppConnectionRequestStatusSchema,
}).strict()
export type AppSetupCardPresenter = z.infer<typeof AppSetupCardPresenterSchema>
