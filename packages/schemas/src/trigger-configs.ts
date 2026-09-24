import { z } from 'zod'

import {
  DocumentTriggerFireOnFieldSchema,
  DocumentTriggerIncludeAgentEditsSchema,
  DocumentTriggerInstructionsSchema,
  DocumentTriggerKindsSchema,
  DocumentTriggerLabelsSchema,
  DocumentTriggerQuietSecondsSchema,
} from './document-triggers.js'
import type { AgentTriggerType } from './lifecycle.js'
import { describeObjectFields } from './schema-prose.js'
import { TicketAssignOnPickupSchema, TicketChangedStoredConfigSchema } from './ticket-triggers.js'

/**
 * What each agent trigger type is configured with, as one discriminated union
 * (docs/plans/2026-09-23-ticket-driven-agents/triggers.md, "Configuration").
 *
 * Every field carries a `.describe()`, and the agent tools' `type` enum and
 * config prose, and the Agent Designer's trigger catalogue, are generated from
 * this union rather than written by hand. So the union holds exactly the types
 * an agent may be given (a test holds it equal to `RELEASED_TRIGGER_TYPES`).
 *
 * `ticket_changed` and `document_changed` are validated by their arms, by
 * `createAgentTrigger` and `updateAgentTrigger`, which answer with field-level
 * refusals. The other arms describe the keys their fire paths read, and are
 * open to the keys they do not name; those types keep the checks they always
 * had, and the generic refusal with them.
 */

const uuid = z.string().uuid()

const promptField = z
  .string()
  .optional()
  .describe('What the agent should do when this fires.')

const untilField = z
  .string()
  .optional()
  .describe('An ISO 8601 time after which it never runs again.')

export const ManualTriggerConfigSchema = z
  .object({ prompt: promptField })
  .passthrough()
  .describe('Runs when a person presses Run on the Triggers page.')

export const ScheduledTriggerConfigSchema = z
  .object({
    cron: z.string().describe('A cron expression, e.g. "0 9 * * 1-5" for 09:00 on weekdays.'),
    timezone: z.string().optional().describe('The IANA time zone the cron is read in, e.g. "Europe/Prague".'),
    until: untilField,
    mode: z.literal('once').optional().describe('Fire once, at nextRunAt, and then stop.'),
    prompt: promptField,
  })
  .passthrough()
  .describe('Runs on a cron schedule, as the person who created it.')

export const IntervalTriggerConfigSchema = z
  .object({
    interval_minutes: z.number().int().min(1).describe('Minutes between two runs.'),
    until: untilField,
    prompt: promptField,
  })
  .passthrough()
  .describe('Runs every so many minutes, as the person who created it.')

export const WebhookTriggerConfigSchema = z
  .object({ prompt: promptField })
  .passthrough()
  .describe(
    'Runs when a request reaches its intake URL. Its intake key is generated for it '
    + 'and read from the Triggers page, never from chat.',
  )

export const EventTriggerConfigSchema = z
  .object({
    events: z.array(z.string()).min(1).describe('The event names that start the agent.'),
    filter: z
      .record(z.unknown())
      .optional()
      .describe('An exact match on the event payload\'s top-level fields.'),
    prompt: promptField,
  })
  .passthrough()
  .describe('Runs when one of the named platform events happens.')

// ─── ticket_changed ─────────────────────────────────────────────────────────

/** A trigger's per-ticket limits, as a person may set them. */
export const TICKET_TRIGGER_LIMIT_DEFAULTS = { startsPerDay: 20, wakesPerTicket: 30 } as const

/** The platform ceiling each limit is clamped to, whatever a trigger says. */
export const TICKET_TRIGGER_LIMIT_CEILINGS = { startsPerDay: 100, wakesPerTicket: 100 } as const

export const TicketTriggerLimitsSchema = z
  .object({
    wakesPerTicket: z
      .number()
      .int()
      .min(1)
      .max(TICKET_TRIGGER_LIMIT_CEILINGS.wakesPerTicket)
      .default(TICKET_TRIGGER_LIMIT_DEFAULTS.wakesPerTicket)
      .describe(
        'Model runs one ticket\'s work may use, the pickup included. When they are used up the '
        + 'work stops, and a person restarts it by moving the ticket out of and back into a start-work column.',
      ),
    startsPerDay: z
      .number()
      .int()
      .min(1)
      .max(TICKET_TRIGGER_LIMIT_CEILINGS.startsPerDay)
      .default(TICKET_TRIGGER_LIMIT_DEFAULTS.startsPerDay)
      .describe('Tickets this trigger may start work on in one day.'),
  })
  .strict()
  .default({})
  .describe('Limits the platform enforces on this trigger\'s work.')
export type TicketTriggerLimits = z.infer<typeof TicketTriggerLimitsSchema>

const section = (when: string) =>
  z.string().trim().min(1).optional().describe(`Added after general ${when}.`)

export const TicketTriggerInstructionsSchema = z
  .object(
    {
      general: z
        .string({ required_error: 'say what the agent does with every ticket; it opens every wake' })
        .trim()
        .min(1, 'say what the agent does with every ticket; it opens every wake')
        .describe('What the agent does with every ticket. Every wake shows it first.'),
      onPickup: section('when work on a ticket starts'),
      onTicketChanged: section('when the ticket changes while its work is live: a comment, an edit, a move'),
      onSessionTurnEnded: section('when a coding session working the ticket ends a turn'),
      onReminder: section('when a reminder the agent set for the ticket fires'),
      onQueued: section('when the ticket has to wait for a free machine'),
    },
    { required_error: 'give the agent standing instructions, at least {"general": "…"}' },
  )
  .strict()
  .describe(
    'Standing instructions, written by whoever sets the trigger up. Each wake shows general, then '
    + 'the section that matches why the agent woke.',
  )
export type TicketTriggerInstructions = z.infer<typeof TicketTriggerInstructionsSchema>

const PICKUP_COLUMN_REFUSAL =
  'name a column by exactly one of {"id": …}, {"name": …} or {"category": "in_progress" | "review"}'

/**
 * A start-work column as a person or the Designer names it; stored by id.
 * Each form refuses a second key with the same sentence the union refuses a
 * shape it does not know, so `{id, name}` never reads as "unrecognized key".
 */
export const TicketPickupColumnSchema = z.union(
  [
    z.object({ id: uuid.describe('A column id, from project_structure_read.') })
      .strict(PICKUP_COLUMN_REFUSAL),
    z.object({
      name: z.string().trim().min(1).describe('A column\'s name on the board, matched without case.'),
    }).strict(PICKUP_COLUMN_REFUSAL),
    z.object({
      category: z
        .enum(['in_progress', 'review'])
        .describe('Every column of this category on the board.'),
    }).strict(PICKUP_COLUMN_REFUSAL),
  ],
  { errorMap: () => ({ message: PICKUP_COLUMN_REFUSAL }) },
)
export type TicketPickupColumn = z.infer<typeof TicketPickupColumnSchema>

const stored = TicketChangedStoredConfigSchema.shape

/**
 * The `ticket_changed` config as a person or the Designer writes it. The
 * server resolves it into `TicketChangedStoredConfigSchema` — the board and
 * the pickup columns by id — so follow and endOn are that schema's own
 * fields, and the stored form and this one cannot disagree about them.
 */
export const TicketChangedTriggerConfigSchema = z
  .object({
    boardId: uuid
      .optional()
      .describe('The board whose tickets this trigger works. May be left out when the project has one board.'),
    pickup: z
      .object({
        columns: z
          .array(TicketPickupColumnSchema)
          .min(1)
          .describe('Start-work columns: a person who can edit the board moving a ticket into one starts work.'),
        assignOnPickup: TicketAssignOnPickupSchema,
      })
      .strict()
      .nullable()
      .optional()
      .describe('Leave out, or set null, for a trigger that never starts work itself.'),
    follow: stored.follow.describe('Which changes wake the agent while a ticket\'s work is live.'),
    endOn: stored.endOn,
    limits: TicketTriggerLimitsSchema,
    instructions: TicketTriggerInstructionsSchema,
  })
  .strict()
  .describe(
    'Starts an agent\'s work on a ticket when a person who can edit the board moves it into a '
    + 'start-work column, or creates it there, and wakes the agent again while the work is live. '
    + 'A move by an agent, an API token or a connected board never starts work. Every ticket '
    + 'gets its own work thread in the target channel.',
  )
export type TicketChangedTriggerConfig = z.infer<typeof TicketChangedTriggerConfigSchema>

/**
 * The stored config with its limits and instructions typed, for the readers
 * that need them (the work record and its kickoffs). Instructions stay
 * optional: a trigger migrated from a board watcher has none until a person
 * writes them.
 */
export const TicketChangedWorkConfigSchema = TicketChangedStoredConfigSchema.extend({
  limits: TicketTriggerLimitsSchema,
  instructions: TicketTriggerInstructionsSchema.optional(),
})
export type TicketChangedWorkConfig = z.infer<typeof TicketChangedWorkConfigSchema>

/** Why the target channel of a ticket trigger is constrained, said once. */
export const TICKET_TRIGGER_TARGET_CHANNEL_RULE =
  'A live, ordinary, public channel of the board\'s project that the agent is bound to. It must be '
  + 'public because every ticket reader has to be able to open the ticket\'s work thread.'

// ─── document_changed ───────────────────────────────────────────────────────

/**
 * The `document_changed` config as a person or the Designer writes it. The
 * server resolves it into `DocumentChangedStoredConfigSchema` — the space
 * always by id — so the narrowing fields are that schema's own.
 */
export const DocumentChangedTriggerConfigSchema = z
  .object({
    spaceId: uuid
      .optional()
      .describe(
        'The document space to watch, of the target channel\'s project. May be left out: then the space of '
        + 'folderPageId or pageIds, or else the project\'s Documents space.',
      ),
    folderPageId: uuid.optional().describe('Only pages inside this folder, at any depth.'),
    pageIds: z.array(uuid).min(1).max(50).optional().describe('Only these pages.'),
    labels: DocumentTriggerLabelsSchema.optional(),
    kinds: DocumentTriggerKindsSchema,
    fireOn: DocumentTriggerFireOnFieldSchema,
    quietSeconds: DocumentTriggerQuietSecondsSchema,
    includeAgentEdits: DocumentTriggerIncludeAgentEditsSchema,
    instructions: DocumentTriggerInstructionsSchema,
  })
  .strict()
  .describe(
    'Wakes the agent when a watched document of the project is saved (or published), once per quiet '
    + 'window, to review the change. An edit to a ticket\'s document reaches that ticket\'s live work for the '
    + 'same agent, in its work thread; any other edit is reviewed in the document\'s own thread in the target '
    + 'channel. The agent reads the change with kb_page_diff; nothing of the document is in the wake itself.',
  )
export type DocumentChangedTriggerConfig = z.infer<typeof DocumentChangedTriggerConfigSchema>

/** Why the target channel of a document trigger is constrained, said once. */
export const DOCUMENT_TRIGGER_TARGET_CHANNEL_RULE =
  'A live, ordinary, public channel of the documents\' project that the agent is bound to. Every reader of '
  + 'that channel must be able to read the watched space, because the agent reviews each change there.'

// ─── The union ─────────────────────────────────────────────────────────────

export const AgentTriggerConfigInputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('manual'), config: ManualTriggerConfigSchema }),
  z.object({ type: z.literal('scheduled'), config: ScheduledTriggerConfigSchema }),
  z.object({ type: z.literal('interval'), config: IntervalTriggerConfigSchema }),
  z.object({ type: z.literal('webhook'), config: WebhookTriggerConfigSchema }),
  z.object({ type: z.literal('event'), config: EventTriggerConfigSchema }),
  z.object({
    type: z.literal('ticket_changed'),
    targetChannelId: uuid.describe(TICKET_TRIGGER_TARGET_CHANNEL_RULE),
    config: TicketChangedTriggerConfigSchema,
  }),
  z.object({
    type: z.literal('document_changed'),
    targetChannelId: uuid.describe(DOCUMENT_TRIGGER_TARGET_CHANNEL_RULE),
    config: DocumentChangedTriggerConfigSchema,
  }),
])
export type AgentTriggerConfigInput = z.infer<typeof AgentTriggerConfigInputSchema>

type UnionType = AgentTriggerConfigInput['type']

/**
 * The trigger types an agent may be given, in the union's order: what the
 * agent tools' `type` enum offers, and what every create surface accepts.
 */
export const AGENT_TRIGGER_INPUT_TYPES: readonly (UnionType & AgentTriggerType)[] =
  AgentTriggerConfigInputSchema.options.map((option) => option.shape.type.value)

const armFor = (type: UnionType): z.AnyZodObject =>
  AgentTriggerConfigInputSchema.optionsMap.get(type) as z.AnyZodObject

/**
 * One trigger type's arm as bullets: what it does (its config's description),
 * then every other field the arm takes, then the config's own fields nested
 * under `config`.
 */
export const describeAgentTriggerType = (type: UnionType, depth = 0): string[] => {
  const arm = armFor(type)
  const config = arm.shape.config as z.AnyZodObject
  const pad = '  '.repeat(depth)
  return [
    `${pad}- ${type} — ${config.description ?? ''}`.trimEnd(),
    ...describeObjectFields(arm.omit({ config: true, type: true }), depth + 1),
    `${pad}  - config: object`,
    ...describeObjectFields(config, depth + 2),
  ]
}

/** Every type an agent may be given, described from the union. */
export const describeAgentTriggerTypes = (depth = 0): string[] =>
  AGENT_TRIGGER_INPUT_TYPES.flatMap((type) => describeAgentTriggerType(type, depth))
