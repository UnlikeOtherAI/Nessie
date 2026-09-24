import { z } from 'zod'

/**
 * What a `document_changed` trigger watches and what its dispatch writes
 * (docs/plans/2026-09-23-ticket-driven-agents/triggers.md, "`document_changed`";
 * docs/standards/document-triggers.md).
 *
 * A person edits one of a project's documents; after a quiet window the
 * trigger's agent is woken to review the edit. The stored configuration is
 * the **resolved** form the server writes — the space always named by id,
 * whatever the person or the Designer left out — so the dispatcher and the
 * writer read one shape. The typed input (`DocumentChangedTriggerConfigSchema`,
 * `trigger-configs.ts`) reuses these fields.
 */
const uuid = z.string().uuid()

/** Which knowledge pages a document trigger can watch. A spreadsheet never: its saves are live cell edits. */
export const DocumentTriggerKindSchema = z.enum(['document', 'file'])
export type DocumentTriggerKind = z.infer<typeof DocumentTriggerKindSchema>

/**
 * `save`: every saved version (a save is deliberate — the product has no live
 * collaborative text editing). `publish`: only a newly published version.
 */
export const DocumentTriggerFireOnSchema = z.enum(['save', 'publish'])
export type DocumentTriggerFireOn = z.infer<typeof DocumentTriggerFireOnSchema>

/** The quiet window, in seconds: saves inside it wake the agent once. */
export const DOCUMENT_TRIGGER_QUIET_SECONDS = { default: 180, min: 10, max: 3_600 } as const

export const DocumentTriggerKindsSchema = z
  .array(DocumentTriggerKindSchema)
  .min(1)
  .default(['document', 'file'])
  .describe('Which pages wake the agent: rich-text documents, Markdown and other files, or both.')

export const DocumentTriggerFireOnFieldSchema = DocumentTriggerFireOnSchema
  .default('save')
  .describe('save: every saved version wakes the agent. publish: only a newly published version does.')

export const DocumentTriggerQuietSecondsSchema = z
  .number()
  .int()
  .min(DOCUMENT_TRIGGER_QUIET_SECONDS.min)
  .max(DOCUMENT_TRIGGER_QUIET_SECONDS.max)
  .default(DOCUMENT_TRIGGER_QUIET_SECONDS.default)
  .describe(
    'Seconds to wait after the first save before waking the agent. Every save in that window '
    + 'wakes it once, with the whole change.',
  )

export const DocumentTriggerIncludeAgentEditsSchema = z
  .boolean()
  .default(false)
  .describe(
    'Let another agent\'s saves wake this agent too. Its own saves never do, so it cannot loop on its own edits.',
  )

export const DocumentTriggerLabelsSchema = z
  .array(z.string().trim().min(1).max(100))
  .min(1)
  .max(20)
  .describe('Only pages carrying at least one of these labels, matched without case.')

export const DocumentTriggerInstructionsSchema = z
  .object(
    {
      general: z
        .string({ required_error: 'say what the agent does with an edited document; it opens every wake' })
        .trim()
        .min(1, 'say what the agent does with an edited document; it opens every wake')
        .describe('What the agent does when a watched document changes. Every wake shows it.'),
    },
    { required_error: 'give the agent standing instructions, at least {"general": "…"}' },
  )
  .strict()
  .describe('Standing instructions, written by whoever sets the trigger up.')
export type DocumentTriggerInstructions = z.infer<typeof DocumentTriggerInstructionsSchema>

/**
 * The stored `document_changed` config: the space by id, and each narrowing
 * as given (null when absent). Instructions are optional here, as a ticket
 * trigger's are, so that a hand-edited instruction costs that field alone;
 * every create and edit requires them.
 */
export const DocumentChangedStoredConfigSchema = z
  .object({
    spaceId: uuid.describe('The document space this trigger watches.'),
    folderPageId: uuid.nullable().default(null).describe('Only pages inside this folder, at any depth.'),
    pageIds: z.array(uuid).min(1).nullable().default(null).describe('Only these pages.'),
    labels: DocumentTriggerLabelsSchema.nullable().default(null),
    kinds: DocumentTriggerKindsSchema,
    fireOn: DocumentTriggerFireOnFieldSchema,
    quietSeconds: DocumentTriggerQuietSecondsSchema,
    includeAgentEdits: DocumentTriggerIncludeAgentEditsSchema,
    instructions: DocumentTriggerInstructionsSchema.optional(),
  })
  .passthrough()
export type DocumentChangedStoredConfig = z.infer<typeof DocumentChangedStoredConfigSchema>

/**
 * The page's own facts a trigger's scope is decided on. `ancestorIds` are the
 * page's folders, nearest first — a folder trigger watches its whole subtree.
 */
export type DocumentTriggerScopeFacts = {
  spaceId: string
  kind: string
  pageId: string
  ancestorIds: readonly string[]
  labels: readonly string[]
}

/** Whether a page is one this trigger watches: the space, the kind, and every narrowing it names. */
export const documentTriggerWatchesPage = (
  config: Pick<DocumentChangedStoredConfig, 'spaceId' | 'folderPageId' | 'pageIds' | 'labels' | 'kinds'>,
  page: DocumentTriggerScopeFacts,
): boolean => {
  if (page.spaceId !== config.spaceId) return false
  if (!(config.kinds as readonly string[]).includes(page.kind)) return false
  if (config.folderPageId && !page.ancestorIds.includes(config.folderPageId)) return false
  if (config.pageIds && !config.pageIds.includes(page.pageId)) return false
  if (config.labels) {
    const wanted = new Set(config.labels.map((label) => label.trim().toLowerCase()))
    if (!page.labels.some((label) => wanted.has(label.trim().toLowerCase()))) return false
  }
  return true
}

/**
 * The queue job's idempotency key while a quiet window is open. The first save
 * of a window enqueues the job delayed by `quietSeconds`; every later save in
 * the window hits this key and adds nothing. The handler releases the key
 * before it reads the page, so a save after that opens the next window.
 */
export const documentTriggerPendingKey = (triggerId: string, pageId: string): string =>
  `doc:${triggerId}:${pageId}:pending`

/** Every delivery of this trigger for this page starts with this; the newest one is the marker. */
export const documentTriggerDeliveryKeyPrefix = (triggerId: string, pageId: string): string =>
  `doc:${triggerId}:${pageId}:`

/** One delivery per (trigger, page, version it brought the agent up to). */
export const documentTriggerDeliveryKey = (triggerId: string, pageId: string, toVersionId: string): string =>
  `${documentTriggerDeliveryKeyPrefix(triggerId, pageId)}${toVersionId}`

/**
 * Why a quiet window woke nobody. Each writes a skipped delivery, so a person
 * asking "I edited it and nothing happened" has an answer on the Triggers page.
 */
export const DocumentTriggerSkipReasonSchema = z.enum([
  // Every new version was the agent's own, or another agent's while the
  // trigger leaves agent edits out: the marker moves past them, nothing wakes.
  'agent_edits_only',
  // The page left the trigger's scope before its window ended: moved out of
  // the folder, its label removed, its kind changed.
  'out_of_scope',
  // The page was deleted before its window ended.
  'page_gone',
  // The agent can no longer read the page or its space, or the space became
  // narrower than the target channel: the trigger is paused with a health reason.
  'access_lost',
  // The stored configuration no longer parses: the trigger matches nothing.
  'config_invalid',
  // A failed delivery, retried, whose change no longer wakes anyone.
  'no_longer_applies',
])
export type DocumentTriggerSkipReason = z.infer<typeof DocumentTriggerSkipReasonSchema>

export const DOCUMENT_TRIGGER_SKIP_SENTENCES = {
  agent_edits_only: 'Only the agent itself (or, with agent edits left out, another agent) saved this document, '
    + 'so nobody was woken.',
  out_of_scope: 'The document left what this trigger watches before its quiet window ended, so nobody was woken.',
  page_gone: 'The document was deleted before its quiet window ended, so nobody was woken.',
  access_lost: 'The agent can no longer read this document or its space, or the space became narrower than the '
    + 'target channel, so the trigger was paused. Its owner can see why on the Triggers page.',
  config_invalid: 'This trigger\'s configuration no longer parses, so it matches nothing.',
  no_longer_applies: 'By the time this was retried, it no longer woke anyone.',
} as const satisfies Record<DocumentTriggerSkipReason, string>

/** Where a document change went: the ticket's live work, the page's own thread, or nowhere (with a reason). */
export const DocumentTriggerOutcomeSchema = z.enum(['ticket_work', 'page_thread', 'skipped'])
export type DocumentTriggerOutcome = z.infer<typeof DocumentTriggerOutcomeSchema>

/** Who saved the versions a wake covers, by kind: never their words, never the document. */
export const DocumentTriggerAuthorKindSchema = z.enum(['person', 'agent'])
export type DocumentTriggerAuthorKind = z.infer<typeof DocumentTriggerAuthorKindSchema>

/**
 * `agent_trigger_deliveries.payload` of a document dispatch: metadata only.
 * No document text, no title — the delivery log is read on the Triggers page,
 * whose readers need not be able to read the document. `toVersionId` is the
 * marker the next window starts from.
 */
export const DocumentTriggerDeliveryPayloadSchema = z
  .object({
    pageId: uuid,
    spaceId: uuid,
    projectId: uuid,
    taskId: uuid.nullable(),
    kind: DocumentTriggerKindSchema,
    fireOn: DocumentTriggerFireOnSchema,
    fromVersionId: uuid.nullable(),
    fromVersionNumber: z.number().int().positive().nullable(),
    toVersionId: uuid,
    toVersionNumber: z.number().int().positive(),
    /** Versions saved after the marker, up to and including `toVersionId`. */
    versionsCoalesced: z.number().int().nonnegative(),
    /** Who saved the versions that woke the agent, by kind. Empty on a skip. */
    authorKinds: z.array(DocumentTriggerAuthorKindSchema),
    /** The size of the version the agent is brought up to, in characters of stored text. */
    bodyChars: z.number().int().nonnegative(),
    outcome: DocumentTriggerOutcomeSchema,
    skipReason: DocumentTriggerSkipReasonSchema.optional(),
    /** `ticket_work`: the ticket's live work record that was woken. */
    workId: uuid.optional(),
    /** The thread the agent was woken in. */
    threadId: uuid.optional(),
  })
  .strict()
  .superRefine((payload, context) => {
    if ((payload.outcome === 'skipped') !== (payload.skipReason !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['skipReason'],
        message: 'A skipped delivery says why, and only a skipped one does.',
      })
    }
  })
export type DocumentTriggerDeliveryPayload = z.infer<typeof DocumentTriggerDeliveryPayloadSchema>

/**
 * `Thread.metadata` of a document's own review thread: one per (trigger,
 * page), in the trigger's target channel, where a change that belongs to no
 * live ticket work is reviewed. Never the channel's General thread.
 */
export const DocumentTriggerThreadMetadataSchema = z
  .object({ pageId: uuid, triggerId: uuid })
  .strict()
export type DocumentTriggerThreadMetadata = z.infer<typeof DocumentTriggerThreadMetadataSchema>

/**
 * One row badge in the Finder and the project's Docs tab: the newest wake a
 * document trigger delivered for a page — *"Reviewed by CTO · v5"* — and the
 * thread it happened in, only for a viewer who may open that thread.
 */
export const DocumentReviewRecordSchema = z
  .object({
    pageId: uuid,
    triggerId: uuid,
    agent: z.object({ id: uuid, name: z.string() }).strict(),
    versionNumber: z.number().int().positive(),
    reviewedAt: z.string().datetime(),
    /** Where the review happened, only for a viewer who may open that thread. */
    thread: z.object({ id: uuid, channelId: uuid }).strict().nullable(),
  })
  .strict()
export type DocumentReviewRecord = z.infer<typeof DocumentReviewRecordSchema>

/**
 * `GET /api/knowledge-base/spaces/:spaceId/document-triggers`: the badges for
 * the pages the viewer asked about and can read, and whether the viewer may
 * set up a trigger (the Triggers routes' own owner gate), which decides
 * whether "Tell an agent when this changes…" is offered.
 */
export const SpaceDocumentTriggersRecordSchema = z
  .object({
    viewerCanCreateTriggers: z.boolean(),
    projectId: uuid,
    reviews: z.array(DocumentReviewRecordSchema),
  })
  .strict()
export type SpaceDocumentTriggersRecord = z.infer<typeof SpaceDocumentTriggersRecordSchema>
