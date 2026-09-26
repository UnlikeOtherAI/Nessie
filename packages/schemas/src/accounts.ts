import { z } from 'zod'

import { NonEmptyStringSchema, TimestampSchema } from './schema-primitives.js'
import { AgentVisibilitySchema } from './team-records.js'

/**
 * Accounts: one read model over every login a person or the company holds at
 * another service (plan §6.7, §10.1). The six stores stay where they are —
 * comms connections, connected mailboxes, personal app connections, ticket
 * tool connections, personal AI plans and cloud browser accounts — and this is
 * the one row shape they are projected into, so a person sees one list with
 * one status vocabulary.
 */

/** The six stores an account row is projected from. */
export const ACCOUNT_KINDS = ['comms', 'mailbox', 'app', 'tickets', 'ai-plan', 'browser'] as const
export const AccountKindSchema = z.enum(ACCOUNT_KINDS)
export type AccountKind = z.infer<typeof AccountKindSchema>

/**
 * What the one grant write can name. A computer is not an account — it is a
 * paired machine with its own page — but "which agents may use it" is the same
 * decision, so the grant routes accept it and the same component renders it.
 */
export const GRANT_SUBJECT_KINDS = [...ACCOUNT_KINDS, 'computer'] as const
export const GrantSubjectKindSchema = z.enum(GRANT_SUBJECT_KINDS)
export type GrantSubjectKind = z.infer<typeof GrantSubjectKindSchema>

const UUID = z.string().uuid()

/**
 * An account is addressed as `<kind>:<id>`, the shape the scope switch already
 * uses for `team:<id>`. The kind is structural: it names the store, so a read
 * never guesses which table an id belongs to.
 */
export const formatAccountId = (kind: GrantSubjectKind, id: string): string => `${kind}:${id}`

export type ParsedAccountId = { id: string; kind: GrantSubjectKind }

export const parseAccountId = (value: string): ParsedAccountId | null => {
  const separator = value.indexOf(':')
  if (separator <= 0) return null
  const kind = GrantSubjectKindSchema.safeParse(value.slice(0, separator))
  const id = UUID.safeParse(value.slice(separator + 1))
  return kind.success && id.success ? { id: id.data, kind: kind.data } : null
}

/** An account id that names a listed account — every grant subject but a computer. */
export const parseListedAccountId = (value: string): { id: string; kind: AccountKind } | null => {
  const parsed = parseAccountId(value)
  if (!parsed || parsed.kind === 'computer') return null
  return { id: parsed.id, kind: parsed.kind }
}

// ─── Status ─────────────────────────────────────────────────────────────────

/**
 * The five words (plan §6.9). Every store's own status and health reason maps
 * onto one of these, and the sentence beside it says what to do.
 */
export const AccountStatusWordSchema = z.enum([
  'connected',
  'needs_attention',
  'turned_off',
  'not_finished',
  'error',
])
export type AccountStatusWord = z.infer<typeof AccountStatusWordSchema>

/**
 * The one step that fixes a status, as a code the screen turns into a
 * control. `none` means nothing needs doing; `wait` means the service is
 * expected to recover on its own; `ask` means somebody else holds the fix.
 */
export const AccountRemedySchema = z.enum([
  'none',
  'reconnect',
  'replace_key',
  'test',
  'resync',
  'finish_setup',
  'wait',
  'ask',
])
export type AccountRemedy = z.infer<typeof AccountRemedySchema>

export const AccountStatusSchema = z.object({
  word: AccountStatusWordSchema,
  sentence: NonEmptyStringSchema,
  remedy: AccountRemedySchema,
})
export type AccountStatus = z.infer<typeof AccountStatusSchema>

// ─── The row ────────────────────────────────────────────────────────────────

/** Which Connected accounts tab lists the row — what the account is for. */
export const AccountPurposeSchema = z.enum(['mail', 'chat', 'tickets', 'browsers', 'ai', 'apps'])
export type AccountPurpose = z.infer<typeof AccountPurposeSchema>

export const AccountScopeSchema = z.enum(['person', 'team', 'organisation'])
export type AccountScope = z.infer<typeof AccountScopeSchema>

export const AccountOwnerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('person'),
    userId: UUID,
    displayName: z.string().nullable(),
    isViewer: z.boolean(),
  }),
  z.object({ kind: z.literal('team'), teamId: UUID, name: z.string() }),
  z.object({ kind: z.literal('organisation') }),
])
export type AccountOwner = z.infer<typeof AccountOwnerSchema>

/** The Integrations pages (`/admin/apps/integrations/:slug`). */
export const INTEGRATION_SLUGS = [
  'google-workspace',
  'microsoft-365',
  'slack',
  'jira',
  'linear',
  'github',
  'trello',
  'deep-water',
  'cloud-browser',
  'local-ai',
] as const
export const IntegrationSlugSchema = z.enum(INTEGRATION_SLUGS)
export type IntegrationSlug = z.infer<typeof IntegrationSlugSchema>

/**
 * How an account decides which agents may use it. The rule is the store's own
 * and is never widened by this read:
 *
 * - `listed` — one access row per agent decides (a connected mailbox).
 * - `requester` — any agent the owner talks to may use it in the owner's own
 *   conversations (a Google, Microsoft or Slack account; a personal app).
 * - `owned_agents` — the owner's own agents that run on it (an AI plan).
 * - `browser_grant` — agents holding the cloud browser grant.
 * - `not_used` — agents never use it directly; projects sync through it.
 */
export const AccountAgentRuleSchema = z.enum([
  'listed',
  'requester',
  'owned_agents',
  'browser_grant',
  'not_used',
])
export type AccountAgentRule = z.infer<typeof AccountAgentRuleSchema>

export const AccountAgentsSummarySchema = z.object({
  rule: AccountAgentRuleSchema,
  /** Agents the rule names today; null where the rule is not a list. */
  count: z.number().int().nonnegative().nullable(),
  /** Whether the viewer may change which agents use it, here. */
  canManage: z.boolean(),
})
export type AccountAgentsSummary = z.infer<typeof AccountAgentsSummarySchema>

/** What the viewer may do from the row, each already authorised by the server. */
export const AccountActionSchema = z.enum(['open_mail', 'test', 'resync', 'reconnect', 'disconnect'])
export type AccountAction = z.infer<typeof AccountActionSchema>

export const AccountRecordSchema = z.object({
  id: NonEmptyStringSchema,
  kind: AccountKindSchema,
  /** A stable key for the service: `google`, `imap`, `jira`, `kimi`, an app's slug. */
  service: NonEmptyStringSchema,
  /** The service by its name, never a protocol ("Other email provider"). */
  serviceName: NonEmptyStringSchema,
  purpose: AccountPurposeSchema,
  /** The account itself: an address, a workspace, a plan's account label. */
  label: NonEmptyStringSchema,
  /** One secondary line, when there is something worth saying. */
  detail: z.string().nullable(),
  scope: AccountScopeSchema,
  owner: AccountOwnerSchema,
  status: AccountStatusSchema,
  /** What it lets agents do, in words. */
  capabilities: z.array(NonEmptyStringSchema),
  agents: AccountAgentsSummarySchema,
  actions: z.array(AccountActionSchema),
  integration: IntegrationSlugSchema.nullable(),
  connectedAt: TimestampSchema,
  lastActiveAt: TimestampSchema.nullable(),
})
export type AccountRecord = z.infer<typeof AccountRecordSchema>

export const AccountListResponseSchema = z.object({
  accounts: z.array(AccountRecordSchema),
})
export type AccountListResponse = z.infer<typeof AccountListResponseSchema>

/** `?scope=me|organisation|team:<id>` — whose accounts a list reads. */
export type AccountListScope =
  | { kind: 'me' }
  | { kind: 'organisation' }
  | { kind: 'team'; teamId: string }

export const parseAccountListScope = (value: string | undefined): AccountListScope | null => {
  if (value === undefined || value === 'me') return { kind: 'me' }
  if (value === 'organisation') return { kind: 'organisation' }
  if (!value.startsWith('team:')) return null
  const teamId = UUID.safeParse(value.slice('team:'.length))
  return teamId.success ? { kind: 'team', teamId: teamId.data } : null
}

export const formatAccountListScope = (scope: AccountListScope): string =>
  scope.kind === 'team' ? `team:${scope.teamId}` : scope.kind

// ─── Used in ────────────────────────────────────────────────────────────────

/**
 * Why an agent depends on an account. Each reason is the store's own
 * relation, so revoking is never blind: `may_use` is an access row, `runs_on`
 * a model pinned to an AI plan, `browser` a durable agent browser on the
 * account, `acts_without_asking` a standing send permission.
 */
export const AccountDependentAgentReasonSchema = z.enum([
  'may_use',
  'runs_on',
  'browser',
  'acts_without_asking',
])
export type AccountDependentAgentReason = z.infer<typeof AccountDependentAgentReasonSchema>

export const AccountUsedInSchema = z.object({
  agents: z.array(z.object({
    id: UUID,
    name: NonEmptyStringSchema,
    reason: AccountDependentAgentReasonSchema,
  })),
  projects: z.array(z.object({ id: UUID, name: NonEmptyStringSchema })),
  automations: z.array(z.object({ id: UUID, name: NonEmptyStringSchema })),
  browsers: z.array(z.object({
    agentId: UUID,
    agentName: NonEmptyStringSchema,
    signedInSites: z.number().int().nonnegative(),
  })),
  /** Dependents the viewer may not see, counted but never named. */
  hiddenCount: z.number().int().nonnegative(),
})
export type AccountUsedIn = z.infer<typeof AccountUsedInSchema>

export const AccountDetailSchema = z.object({
  account: AccountRecordSchema,
  usedIn: AccountUsedInSchema,
})
export type AccountDetail = z.infer<typeof AccountDetailSchema>

// ─── Agents with access ─────────────────────────────────────────────────────

/**
 * One agent beside one account, as the grant component shows it. `allowed` is
 * this account's own decision (null where the rule has no per-agent switch);
 * `tools` is the agent's own tool decision where the account needs one too —
 * a connected mailbox needs both, and neither write rewrites the other.
 */
export const AccountAgentGrantSchema = z.object({
  agentId: UUID,
  name: NonEmptyStringSchema,
  role: z.string().nullable(),
  visibility: AgentVisibilitySchema,
  allowed: z.boolean().nullable(),
  tools: z.enum(['on', 'off']).nullable(),
})
export type AccountAgentGrant = z.infer<typeof AccountAgentGrantSchema>

export const AccountAgentGrantsSchema = z.object({
  subjectId: NonEmptyStringSchema,
  rule: AccountAgentRuleSchema,
  canManage: z.boolean(),
  /** Who can change these when the viewer cannot, in words. */
  manageReason: z.string().nullable(),
  /** The name of the agent-side tool decision, when there is one ("Mailbox tools"). */
  toolsLabel: z.string().nullable(),
  agents: z.array(AccountAgentGrantSchema),
})
export type AccountAgentGrants = z.infer<typeof AccountAgentGrantsSchema>

export const SetAccountAgentAccessBodySchema = z.object({ allowed: z.boolean() }).strict()
export type SetAccountAgentAccessBody = z.infer<typeof SetAccountAgentAccessBodySchema>

/**
 * The mirror: one agent's switchable accounts, read from the agent's side so
 * an agent's Access tab shows the same decisions an account page writes.
 */
export const AgentAccountGrantSchema = z.object({
  account: AccountRecordSchema,
  allowed: z.boolean(),
  canManage: z.boolean(),
  tools: z.enum(['on', 'off']).nullable(),
})
export type AgentAccountGrant = z.infer<typeof AgentAccountGrantSchema>

export const AgentAccountGrantsSchema = z.object({
  agentId: UUID,
  accounts: z.array(AgentAccountGrantSchema),
})
export type AgentAccountGrants = z.infer<typeof AgentAccountGrantsSchema>
