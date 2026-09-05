import { z } from 'zod'

import { ColumnCategorySchema } from './board-lifecycle.js'
import { AgentIdSchema, ProjectIdSchema, UserIdSchema } from './ids.js'
import { NonEmptyStringSchema, TimestampSchema } from './schema-primitives.js'

/**
 * External board sources: the contracts the API, the worker and the admin all
 * read. Adapter-side shapes live in `@nessie/board-sources`; these are the
 * persisted and wire shapes.
 */

export const BoardSourceProviderSchema = z.enum(['jira', 'linear', 'trello', 'github'])
export type BoardSourceProvider = z.infer<typeof BoardSourceProviderSchema>

export const BoardSourceConnectionStatusSchema = z.enum([
  'active',
  'needs_reauthorization',
  'revoked',
])
export type BoardSourceConnectionStatus = z.infer<typeof BoardSourceConnectionStatusSchema>

export const BoardSourceAuthMethodSchema = z.enum(['oauth', 'api_key'])
export type BoardSourceAuthMethod = z.infer<typeof BoardSourceAuthMethodSchema>

/**
 * One field of a provider's pasted-credential form, as the adapter declares it.
 * `secret` values are write-only — they go up and are never sent back.
 */
export const CredentialFieldSchema = z.object({
  key: NonEmptyStringSchema,
  label: NonEmptyStringSchema,
  kind: z.enum(['secret', 'text', 'email', 'url']),
  help: z.string().optional(),
  placeholder: z.string().optional(),
})

export const CredentialFormSchema = z.object({
  createUrl: z.string().url(),
  createLabel: NonEmptyStringSchema,
  fields: CredentialFieldSchema.array().min(1),
})
export type CredentialForm = z.infer<typeof CredentialFormSchema>

/** What `GET /api/board-sources/providers` answers: the ways in, per provider. */
export const BoardSourceProviderMethodsSchema = z.object({
  provider: BoardSourceProviderSchema,
  methods: BoardSourceAuthMethodSchema.array(),
  apiKeyForm: CredentialFormSchema.nullable(),
})
export type BoardSourceProviderMethods = z.infer<typeof BoardSourceProviderMethodsSchema>

/**
 * The pasted values, keyed by the form's own field keys. Deliberately a loose
 * record: which keys are required is the adapter's declaration, and duplicating
 * it here would be two schemas to keep in step.
 */
export const ConnectApiKeyBodySchema = z.object({
  values: z.record(z.string(), z.string()),
})
export type ConnectApiKeyBody = z.infer<typeof ConnectApiKeyBodySchema>

export const BoardSourceWriteModeSchema = z.enum(['read_only', 'read_write'])
export type BoardSourceWriteMode = z.infer<typeof BoardSourceWriteModeSchema>

export const BoardSourceHealthSchema = z.enum([
  'active',
  'paused',
  'needs_reauthorization',
  'owner_inactive',
  'misconfigured',
  'error',
])
export type BoardSourceHealth = z.infer<typeof BoardSourceHealthSchema>

/**
 * Where an external state lands. `archived` is not a column category — it is
 * how a cancelled or deleted upstream item leaves the board — and `null` means
 * a person has not decided yet, which moves the source to `misconfigured`
 * rather than guessing.
 */
export const BoardSourceStateTargetSchema = z.union([
  ColumnCategorySchema,
  z.literal('archived'),
  z.null(),
])

export const BoardSourceStateMappingSchema = z
  .object({
    externalStateId: NonEmptyStringSchema,
    externalStateName: NonEmptyStringSchema,
    category: BoardSourceStateTargetSchema,
    /**
     * The state a write-back into this category writes. Required rather than
     * defaulted: the mapping is edited and sent as a whole document, and a
     * `.default()` would make the schema's input and output types diverge for
     * every caller that parses a request body.
     */
    isDefaultForCategory: z.boolean(),
  })
  .strict()
export type BoardSourceStateMapping = z.infer<typeof BoardSourceStateMappingSchema>

/** A native task field an external field may target, or one custom definition. */
export const BoardSourceFieldTargetSchema = z.union([
  z.literal('native:priority'),
  z.literal('native:dueDate'),
  z.literal('native:storyPoints'),
  z.literal('native:title'),
  z.literal('native:detail'),
  z.string().regex(/^field:[0-9a-f-]{36}$/, 'expected field:<definitionId>'),
])

export const BoardSourceFieldMappingSchema = z
  .object({
    externalKey: NonEmptyStringSchema,
    externalLabel: NonEmptyStringSchema,
    target: BoardSourceFieldTargetSchema,
    /** External option id → Nessie option id, for select-shaped fields. */
    valueMap: z.record(z.string(), z.string()).optional(),
  })
  .strict()
export type BoardSourceFieldMapping = z.infer<typeof BoardSourceFieldMappingSchema>

export const BoardSourceIdentityLinkRecordSchema = z.object({
  id: z.string().uuid(),
  externalUserId: NonEmptyStringSchema,
  externalDisplayName: z.string().nullable(),
  userId: UserIdSchema.nullable(),
  agentId: AgentIdSchema.nullable(),
  matchedBy: z.enum(['email', 'manual']),
})
export type BoardSourceIdentityLinkRecord = z.infer<
  typeof BoardSourceIdentityLinkRecordSchema
>

export const BoardSourceConnectionRecordSchema = z.object({
  id: z.string().uuid(),
  provider: BoardSourceProviderSchema,
  status: BoardSourceConnectionStatusSchema,
  authMethod: BoardSourceAuthMethodSchema,
  externalAccountId: z.string(),
  externalTenantId: z.string(),
  ownerUserId: UserIdSchema,
  ownerDisplayName: z.string().nullable(),
  /** Whether the caller is the person whose authority this connection carries. */
  isOwnedByViewer: z.boolean(),
  lastVerifiedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
})
export type BoardSourceConnectionRecord = z.infer<typeof BoardSourceConnectionRecordSchema>

export const BoardSourceRecordSchema = z.object({
  id: z.string().uuid(),
  projectId: ProjectIdSchema,
  connectionId: z.string().uuid(),
  provider: BoardSourceProviderSchema,
  name: NonEmptyStringSchema,
  container: z.record(z.string(), z.unknown()),
  containerKey: z.string(),
  writeMode: BoardSourceWriteModeSchema,
  syncWindowDays: z.number().int(),
  healthState: BoardSourceHealthSchema,
  healthReason: z.string().nullable(),
  healthDetail: z.string().nullable(),
  lastSyncCompletedAt: TimestampSchema.nullable(),
  lastErrorCode: z.string().nullable(),
  /** Whose delegated authority the sync runs under. */
  connectionOwnerUserId: UserIdSchema,
  connectionOwnerDisplayName: z.string().nullable(),
  itemCount: z.number().int(),
  // On the list rather than only the detail: a board's column editor needs
  // every source's states to offer bindings, and a handful of states per source
  // is far cheaper than one detail fetch per source.
  stateMapping: BoardSourceStateMappingSchema.array(),
})
export type BoardSourceRecord = z.infer<typeof BoardSourceRecordSchema>

export const BoardSourceDetailRecordSchema = BoardSourceRecordSchema.extend({
  fieldMappings: BoardSourceFieldMappingSchema.array(),
  identityLinks: BoardSourceIdentityLinkRecordSchema.array(),
  /** The container as last described, so the mapping tables have rows to show. */
  states: z
    .object({ id: z.string(), name: z.string() })
    .array(),
  fields: z
    .object({ key: z.string(), label: z.string(), type: z.string() })
    .array(),
  members: z
    .object({ externalUserId: z.string(), displayName: z.string(), email: z.string().optional() })
    .array(),
})
export type BoardSourceDetailRecord = z.infer<typeof BoardSourceDetailRecordSchema>

export const TaskExternalLinkRecordSchema = z.object({
  sourceId: z.string().uuid(),
  provider: BoardSourceProviderSchema,
  externalKey: z.string(),
  externalUrl: z.string(),
  remoteStateName: z.string().nullable(),
  remoteAssigneeDisplay: z.string().nullable(),
  lastInboundAt: TimestampSchema.nullable(),
  writeMode: BoardSourceWriteModeSchema,
})
export type TaskExternalLinkRecord = z.infer<typeof TaskExternalLinkRecordSchema>

// ─── Bodies ───────────────────────────────────────────────────────────────

export const CreateBoardSourceBodySchema = z
  .object({
    connectionId: z.string().uuid(),
    container: z.record(z.string(), z.unknown()),
    name: NonEmptyStringSchema.max(120).optional(),
  })
  .strict()

export const UpdateBoardSourceBodySchema = z
  .object({
    name: NonEmptyStringSchema.max(120).optional(),
    writeMode: BoardSourceWriteModeSchema.optional(),
    syncWindowDays: z.number().int().min(1).max(3650).optional(),
    connectionId: z.string().uuid().optional(),
  })
  .strict()

/** The whole mapping document, replaced at once — a partial merge of three
 *  interdependent tables is a merge nobody can reason about. */
export const PutBoardSourceMappingsBodySchema = z
  .object({
    stateMapping: BoardSourceStateMappingSchema.array(),
    fieldMappings: BoardSourceFieldMappingSchema.array(),
    identityLinks: z
      .object({
        externalUserId: NonEmptyStringSchema,
        externalDisplayName: z.string().nullable().optional(),
        userId: UserIdSchema.nullable().optional(),
        agentId: AgentIdSchema.nullable().optional(),
      })
      .strict()
      .array(),
  })
  .strict()

// ─── Worker topics ────────────────────────────────────────────────────────

export const BOARD_SOURCE_SYNC_INITIAL_TOPIC = 'board-source.sync.initial'
export const BOARD_SOURCE_SYNC_INCREMENTAL_TOPIC = 'board-source.sync.incremental'
export const BOARD_SOURCE_SYNC_SWEEP_TOPIC = 'board-source.sync.sweep'
export const BOARD_SOURCE_WEBHOOK_PROCESS_TOPIC = 'board-source.webhook.process'
export const BOARD_SOURCE_WEBHOOKS_RENEW_TOPIC = 'board-source.webhooks.renew'
export const BOARD_SOURCE_HEALTH_ALERT_TOPIC = 'board-source.health-alert'

export const BoardSourceSyncJobPayloadSchema = z.object({ sourceId: z.string().uuid() })
export const BoardSourceSweepJobPayloadSchema = z.object({ bucket: z.string().optional() })
export const BoardSourceWebhookJobPayloadSchema = z.object({
  provider: BoardSourceProviderSchema,
  headers: z.record(z.string(), z.string()),
  rawBody: z.string(),
  token: z.string().optional(),
})
export const BoardSourceWebhooksRenewJobPayloadSchema = z.object({
  withinMs: z.number().int().positive(),
})
export const BoardSourceHealthAlertJobPayloadSchema = z.object({
  sourceId: z.string().uuid(),
  revision: z.number().int(),
})

/** How long a board source may run before the sweep reclaims it. */
export const BOARD_SOURCE_CLAIM_TIMEOUT_MS = 10 * 60 * 1000
/** Backoff ceiling; after this a failing source is `error` with its code. */
export const BOARD_SOURCE_BACKOFF_CEILING_MS = 6 * 60 * 60 * 1000
