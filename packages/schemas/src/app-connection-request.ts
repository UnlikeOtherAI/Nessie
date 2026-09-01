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
 * Safe App Store presentation shared by conversational search and the durable
 * consent snapshot. It intentionally excludes endpoint, transport
 * configuration, authorization links and credential information.
 */
export const AppStoreSafePresentationSchema = z.object({
  authMethod: AppAuthMethodSchema,
  capabilityCount: z.number().int().nonnegative().nullable(),
  catalogEntryId: z.string().uuid(),
  displayName: NonEmptyStringSchema,
  iconUrl: z.string().nullable(),
  shortDescription: z.string(),
  trustLevel: AppTrustLevelSchema,
}).strict()
export type AppStoreSafePresentation = z.infer<typeof AppStoreSafePresentationSchema>

/** Server-derived candidate presentation for a first-party App setup card. */
export const AppSetupCardCandidateSchema = AppStoreSafePresentationSchema
export type AppSetupCardCandidate = z.infer<typeof AppSetupCardCandidateSchema>

/** Read-only catalogue search accepted from a model. */
export const AppSearchToolInputSchema = z.object({
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(10).optional(),
}).strict()
export type AppSearchToolInput = z.infer<typeof AppSearchToolInputSchema>

export const AppSearchToolOutputSchema = z.object({
  apps: z.array(AppStoreSafePresentationSchema).max(10),
}).strict()
export type AppSearchToolOutput = z.infer<typeof AppSearchToolOutputSchema>

/** The model needs only confirmation that its request card was offered. */
export const AppConnectRequestToolOutputSchema = z.object({
  status: z.literal('offered'),
}).strict()
export type AppConnectRequestToolOutput = z.infer<typeof AppConnectRequestToolOutputSchema>

/** One authenticated click selects a server-recorded candidate to connect. */
export const BeginAppConnectionRequestSchema = z.object({
  catalogEntryId: z.string().uuid(),
}).strict()
export type BeginAppConnectionRequest = z.infer<typeof BeginAppConnectionRequestSchema>

/**
 * Deliberately immediate-only response to Begin. An authorization URL is never
 * stored in message metadata, a card cache, or the durable request itself.
 */
export const BeginAppConnectionRequestResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('connected') }).strict(),
  z.object({ authorizationUrl: z.string().url(), status: z.literal('authorize') }).strict(),
  z.object({ status: z.literal('needs_secret') }).strict(),
])
export type BeginAppConnectionRequestResponse = z.infer<
  typeof BeginAppConnectionRequestResponseSchema
>

/**
 * Immutable, server-authored state captured at offer time. It deliberately
 * contains no model reason, URL, account, instance, or credential value.
 */
export const AppConnectionRequestConsentSnapshotSchema = z.object({
  agent: z.object({
    id: z.string().uuid(),
    name: NonEmptyStringSchema,
  }).strict(),
  candidates: z.array(AppStoreSafePresentationSchema).min(1).max(3),
  scope: z.object({
    label: NonEmptyStringSchema,
    scopeId: z.string().uuid(),
    scopeType: z.literal('user'),
  }).strict(),
}).strict()
export type AppConnectionRequestConsentSnapshot = z.infer<
  typeof AppConnectionRequestConsentSnapshotSchema
>

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
