import { z } from 'zod'

/**
 * Agent chat cards — one interactive card system for every agent.
 *
 * A card is a persistent, structured message an agent posts into a
 * conversation: a ticket summary, an email overview, an image with a caption,
 * a small form. It carries a row of buttons; a person presses one, the press
 * is claimed exactly once, and the card freezes into a terminal state that is
 * retained in the chat and in the agent's own context.
 *
 * "Universal" is delivered by making the body a list of **blocks** from a
 * closed vocabulary and the footer a list of **actions**, so a ticket, an
 * email overview, an image and a form are four arrangements of the same parts
 * under one renderer. There is deliberately no `kind: 'linear_ticket'` — a
 * kind enum is a per-integration renderer in waiting, and the eighth bespoke
 * card component is the defect Rule zero names.
 *
 * Design: docs/plans/2026-09-01-agent-chat-cards.md
 */

/** Machine keys for inputs and actions: stable, lowercase, model-authored. */
export const AgentCardKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,31}$/, 'Keys are lowercase, start with a letter, max 32 characters')
export type AgentCardKey = z.infer<typeof AgentCardKeySchema>

export const AGENT_CARD_MAX_BLOCKS = 12
export const AGENT_CARD_MAX_ACTIONS = 4
export const AGENT_CARD_MAX_FIELDS = 12
export const AGENT_CARD_MAX_OPTIONS = 20
/** 60 seconds … 30 days. Below a minute nobody can answer; beyond a month is not a card. */
export const AGENT_CARD_MIN_EXPIRY_SECONDS = 60
export const AGENT_CARD_MAX_EXPIRY_SECONDS = 30 * 24 * 60 * 60

/**
 * Where a `secret` block's value is stored. The plaintext is submitted once,
 * placed by its typed connector or dashboard-source credential seam, and never
 * recorded on the card, the message, the audit metadata, or the model's
 * context — only the fact that it was provided, and where it landed.
 *
 * `connector_credential` configures an installed app. A
 * `dashboard_source_credential` configures the HTTPS source the Dashboard
 * Designer just created. Both are Prisma-backed operations which commit with
 * the press.
 *
 * `vault_secret` is the general destination: the person's own Secrets, for a
 * credential that belongs to them rather than to one connector. It is the
 * only one whose write is an external HTTP call and so cannot join the press
 * transaction — the vault write is performed first and rolled back if the
 * press does not commit, exactly as `POST /api/secrets` does. The agent names
 * the secret so the form arrives pre-filled; it can never read the value back,
 * and `scopeType` beyond `personal` is refused for anyone but an owner.
 */
export const AgentCardSecretDestinationSchema = z
  .union([
    z
      .object({
        kind: z.literal('vault_secret'),
        /**
         * The environment-variable-style name the form arrives pre-filled
         * with. Same grammar as `POST /api/secrets`, so a card cannot create a
         * secret the Secrets screen would have refused.
         */
        name: z
          .string()
          .trim()
          .min(1)
          .max(120)
          .regex(/^[A-Z][A-Z0-9_]*$/, 'Use an environment-variable-style name.'),
        description: z.string().trim().max(1_000).optional(),
        provider: z.string().trim().max(120).optional(),
        scopeType: z.enum(['personal', 'team', 'project', 'organization']).default('personal'),
        scopeId: z.string().uuid().optional(),
        /**
         * A message in this card's own thread whose stored text still carries
         * the credential — the "take it back out of the context" half.
         *
         * This is what a model-spotted secret needs and the scanner cannot
         * give: an agent that recognises an in-house token format the patterns
         * will never match points at the message, and the press rewrites it.
         * The agent supplies only the id. The replacement text is computed by
         * the server from the value the person actually typed, so an agent can
         * neither choose the new wording nor edit a message by this route.
         */
        redactMessageId: z.string().uuid().optional(),
      })
      .strict()
      .superRefine((destination, ctx) => {
        // Without this the card renders, the person types their credential, and
        // only then does the press refuse for a scope that could never resolve.
        if (
          (destination.scopeType === 'team' || destination.scopeType === 'project')
          && !destination.scopeId
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'A team or project secret needs scopeId.',
            path: ['scopeId'],
          })
        }
      }),
    z
      .object({
        kind: z.literal('connector_credential'),
        instanceId: z.string().uuid(),
        /** Place on the instance for everyone rather than the presser's own override. */
        shared: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('dashboard_source_credential'),
        sourceId: z.string().uuid(),
        mode: z.enum(['bearer', 'header']),
        headerName: z.string().trim().min(1).max(64).optional(),
      })
      .strict()
      .superRefine((destination, ctx) => {
        if (destination.mode === 'header' && !destination.headerName) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'A header credential needs headerName.',
            path: ['headerName'],
          })
        }
      }),
  ])
export type AgentCardSecretDestination = z.infer<typeof AgentCardSecretDestinationSchema>

export const AgentCardInputKindSchema = z.enum([
  'text',
  'textarea',
  'number',
  'select',
  'checkbox',
  'date',
])
export type AgentCardInputKind = z.infer<typeof AgentCardInputKindSchema>

const TextBlockSchema = z
  .object({
    type: z.literal('text'),
    markdown: z.string().trim().min(1).max(2000),
  })
  .strict()

const FieldsBlockSchema = z
  .object({
    type: z.literal('fields'),
    items: z
      .array(
        z
          .object({
            label: z.string().trim().min(1).max(60),
            value: z.string().trim().min(1).max(300),
          })
          .strict(),
      )
      .min(1)
      .max(AGENT_CARD_MAX_FIELDS),
  })
  .strict()

/**
 * An image the run can already reach — an attachment id, never a URL. A URL
 * would have every viewer's browser announce the card to a third-party host
 * and fetch untrusted bytes; the attachment path is MIME-checked, thumbnailed
 * and served through the one `FileService`.
 */
const ImageBlockSchema = z
  .object({
    type: z.literal('image'),
    attachmentId: z.string().uuid(),
    alt: z.string().trim().min(1).max(200),
    caption: z.string().trim().min(1).max(300).optional(),
  })
  .strict()

const LinkBlockSchema = z
  .object({
    type: z.literal('link'),
    href: z
      .string()
      .url()
      .refine((value) => value.startsWith('https://'), 'Card links must be https'),
    label: z.string().trim().min(1).max(80),
  })
  .strict()

const InputBlockSchema = z
  .object({
    type: z.literal('input'),
    key: AgentCardKeySchema,
    label: z.string().trim().min(1).max(80),
    input: AgentCardInputKindSchema,
    required: z.boolean().optional(),
    placeholder: z.string().trim().max(120).optional(),
    options: z
      .array(
        z
          .object({
            value: z.string().trim().min(1).max(120),
            label: z.string().trim().min(1).max(120),
          })
          .strict(),
      )
      .min(1)
      .max(AGENT_CARD_MAX_OPTIONS)
      .optional(),
    default: z.union([z.string().max(500), z.number(), z.boolean()]).optional(),
  })
  .strict()
  .superRefine((block, ctx) => {
    if (block.input === 'select' && (block.options?.length ?? 0) === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Input "${block.key}" is a select and needs options.`,
      })
    }
    if (block.input !== 'select' && block.options !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Input "${block.key}" only takes options when it is a select.`,
      })
    }
  })

const SecretBlockSchema = z
  .object({
    type: z.literal('secret'),
    key: AgentCardKeySchema,
    label: z.string().trim().min(1).max(80),
    help: z.string().trim().max(200).optional(),
    destination: AgentCardSecretDestinationSchema,
  })
  .strict()

export const AgentCardBlockSchema = z.union([
  TextBlockSchema,
  FieldsBlockSchema,
  ImageBlockSchema,
  LinkBlockSchema,
  InputBlockSchema,
  SecretBlockSchema,
])
export type AgentCardBlock = z.infer<typeof AgentCardBlockSchema>

export const AgentCardActionStyleSchema = z.enum(['primary', 'secondary', 'danger'])
export type AgentCardActionStyle = z.infer<typeof AgentCardActionStyleSchema>

export const AgentCardActionSchema = z
  .object({
    key: AgentCardKeySchema,
    label: z.string().trim().min(1).max(24),
    style: AgentCardActionStyleSchema,
    /**
     * `true` = the press validates and submits the card's inputs (OK, Allow,
     * Send). `false` = a dismissal that ignores them (Cancel, Not now), so a
     * half-filled form can still be declined.
     */
    submits: z.boolean(),
  })
  .strict()
export type AgentCardAction = z.infer<typeof AgentCardActionSchema>

/**
 * The service the card is about. `key` is matched server-side against the app
 * catalogue to resolve an icon; the model never supplies an icon URL, and a
 * key with no match simply renders the label's initials.
 */
export const AgentCardServiceSchema = z
  .object({
    key: z.string().trim().min(1).max(64),
    label: z.string().trim().min(1).max(40),
  })
  .strict()
export type AgentCardService = z.infer<typeof AgentCardServiceSchema>

const collectDuplicates = (keys: string[]): string[] => {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const key of keys) {
    if (seen.has(key)) duplicates.add(key)
    seen.add(key)
  }
  return [...duplicates]
}

export const AgentCardSpecSchema = z
  .object({
    schemaVersion: z.literal(1),
    service: AgentCardServiceSchema.optional(),
    title: z.string().trim().min(1).max(120),
    subtitle: z.string().trim().min(1).max(200).optional(),
    blocks: z.array(AgentCardBlockSchema).min(1).max(AGENT_CARD_MAX_BLOCKS),
    actions: z.array(AgentCardActionSchema).min(1).max(AGENT_CARD_MAX_ACTIONS),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const fieldKeys = spec.blocks.flatMap((block) =>
      block.type === 'input' || block.type === 'secret' ? [block.key] : [],
    )
    const duplicateFields = collectDuplicates(fieldKeys)
    if (duplicateFields.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Field keys must be unique; repeated: ${duplicateFields.join(', ')}.`,
      })
    }

    const duplicateActions = collectDuplicates(spec.actions.map((action) => action.key))
    if (duplicateActions.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Action keys must be unique; repeated: ${duplicateActions.join(', ')}.`,
      })
    }

    // A card that asks for something needs a way to submit it, or the person
    // is looking at inputs with no button that reads them.
    const asksForInput = spec.blocks.some(
      (block) => block.type === 'input' || block.type === 'secret',
    )
    if (asksForInput && !spec.actions.some((action) => action.submits)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A card with inputs needs at least one action with submits: true.',
      })
    }
  })
export type AgentCardSpec = z.infer<typeof AgentCardSpecSchema>

/**
 * The entire durable payload on the assistant message. The card id is an
 * opaque pointer: the spec, mutable status, who may press, and the resolution
 * are all loaded from the authenticated, viewer-scoped presenter — the same
 * discipline `AppSetupCardSchema` follows, and for the same reason (a press
 * must be claimed by a conditional UPDATE on a row, not a JSON mutation).
 */
export const AgentCardMessageMetadataSchema = z
  .object({
    agentCard: z
      .object({
        cardId: z.string().uuid(),
        schemaVersion: z.literal(1),
      })
      .strict(),
  })
  .strict()
export type AgentCardMessageMetadata = z.infer<typeof AgentCardMessageMetadataSchema>

/**
 * Stamped on the *response* message a press creates. Read structurally by the
 * orchestrator to wake the card's agent — never by matching content.
 */
export const AgentCardResponseMetadataSchema = z
  .object({
    agentCardResponse: z
      .object({
        cardId: z.string().uuid(),
        actionKey: AgentCardKeySchema,
        schemaVersion: z.literal(1),
      })
      .strict(),
  })
  .strict()
export type AgentCardResponseMetadata = z.infer<typeof AgentCardResponseMetadataSchema>

/**
 * Does this message record a card press? The one predicate for that question —
 * the message-edit service refuses these (a "Deny" edited into "Allow" would
 * lie beside a card that says otherwise) and the admin hides the edit
 * affordance on them, and those two must never disagree.
 *
 * Only the key's presence is structural; the metadata around it is not this
 * predicate's business, so a card response is recognised even when a future
 * key sits beside it and the strict schema above would reject the whole
 * object.
 */
export const isAgentCardResponseMessage = (metadata: unknown): boolean =>
  AgentCardResponseMetadataSchema.shape.agentCardResponse.safeParse(
    (metadata as { agentCardResponse?: unknown } | null | undefined)?.agentCardResponse,
  ).success

export const AgentCardStatusSchema = z.enum(['open', 'resolved', 'expired', 'cancelled'])
export type AgentCardStatus = z.infer<typeof AgentCardStatusSchema>

/** Who the agent asked. Resolved to user ids at post time. */
export const AgentCardRespondentsSchema = z.union([
  z.literal('requester'),
  z.literal('thread'),
  z.object({ userIds: z.array(z.string().uuid()).min(1).max(20) }).strict(),
])
export type AgentCardRespondents = z.infer<typeof AgentCardRespondentsSchema>

export const CardPostToolInputSchema = z
  .object({
    card: AgentCardSpecSchema,
    respondents: AgentCardRespondentsSchema.optional(),
    wait: z.boolean().optional(),
    expiresIn: z
      .number()
      .int()
      .min(AGENT_CARD_MIN_EXPIRY_SECONDS)
      .max(AGENT_CARD_MAX_EXPIRY_SECONDS)
      .optional(),
  })
  .strict()
export type CardPostToolInput = z.infer<typeof CardPostToolInputSchema>

export const CardPostToolOutputSchema = z
  .object({
    cardId: z.string().uuid(),
    messageId: z.string().uuid(),
    status: AgentCardStatusSchema,
  })
  .strict()
export type CardPostToolOutput = z.infer<typeof CardPostToolOutputSchema>

/**
 * The presenter's view of a `secret` block: the destination is replaced by a
 * human label, because an instance id is not the viewer's business and the
 * client only needs to know the field is a secret.
 */
const PresentedSecretBlockSchema = z
  .object({
    type: z.literal('secret'),
    key: AgentCardKeySchema,
    label: z.string(),
    help: z.string().optional(),
    destinationLabel: z.string(),
  })
  .strict()

const PresentedImageBlockSchema = z
  .object({
    type: z.literal('image'),
    attachmentId: z.string().uuid(),
    alt: z.string(),
    caption: z.string().optional(),
  })
  .strict()

export const PresentedAgentCardBlockSchema = z.union([
  TextBlockSchema,
  FieldsBlockSchema,
  PresentedImageBlockSchema,
  LinkBlockSchema,
  InputBlockSchema,
  PresentedSecretBlockSchema,
])
export type PresentedAgentCardBlock = z.infer<typeof PresentedAgentCardBlockSchema>

export const AgentCardResolutionSchema = z
  .object({
    actionKey: AgentCardKeySchema,
    actionLabel: z.string(),
    byUserId: z.string().uuid().nullable(),
    byName: z.string().nullable(),
    at: z.string(),
    values: z.record(z.union([z.string(), z.number(), z.boolean()])),
    /** Key → 'provided'. Never a value, never a reference. */
    secrets: z.record(z.literal('provided')),
  })
  .strict()
export type AgentCardResolution = z.infer<typeof AgentCardResolutionSchema>

/**
 * What one viewer may see and do. `action` is the only "is this still
 * actionable?" flag the client trusts: it folds status, expiry, and whether
 * this particular viewer is a respondent into one server decision.
 */
export const AgentCardPresenterSchema = z
  .object({
    cardId: z.string().uuid(),
    messageId: z.string().uuid(),
    threadId: z.string().uuid(),
    agentId: z.string().uuid(),
    agentName: z.string().nullable(),
    title: z.string(),
    subtitle: z.string().optional(),
    service: z
      .object({
        key: z.string(),
        label: z.string(),
        iconUrl: z.string().nullable(),
      })
      .strict()
      .nullable(),
    blocks: z.array(PresentedAgentCardBlockSchema),
    actions: z.array(AgentCardActionSchema),
    status: AgentCardStatusSchema,
    expiresAt: z.string().nullable(),
    action: z.enum(['respond', 'none']),
    /** Display names of the people the agent asked; empty when anyone may press. */
    waitingFor: z.array(z.string()),
    resolution: AgentCardResolutionSchema.nullable(),
  })
  .strict()
export type AgentCardPresenter = z.infer<typeof AgentCardPresenterSchema>

export const AgentCardRespondBodySchema = z
  .object({
    actionKey: AgentCardKeySchema,
    values: z.record(z.union([z.string().max(4000), z.number(), z.boolean()])).optional(),
    secrets: z.record(z.string().min(1).max(8192)).optional(),
  })
  .strict()
export type AgentCardRespondBody = z.infer<typeof AgentCardRespondBodySchema>
