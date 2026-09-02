import type { PrismaClient } from '@prisma/client'
import { loadConfig } from '@nessie/config'
import {
  AgentEffortSchema,
  AgentRunLimitsSchema,
  AgentTriggerTypeSchema,
  AgentVisibilitySchema,
  type AgentModelOption,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import type { LedgerIdentityService } from '@nessie/runtime'
import {
  getGlobalAgentBlueprint,
  ledgerAgentModelCatalogRequestHeaders,
  listLedgerAgentModels,
  loadAgentToolCatalog,
  type AgentToolCatalog,
  type AgentToolCatalogEntry,
  type AgentToolCatalogRestrictedEntry,
} from '@nessie/workspace-admin'

import type { RunContext } from './types.js'

/**
 * The Agent Designer's authority: the complete catalogue of what an agent can
 * be, GENERATED from the same sources the product itself reads.
 *
 * Hand-written prose about parameters or tool lists is forbidden here. Every
 * enum below comes from the contract that validates it, every tool from
 * `BUILTIN_TOOL_DEFINITIONS` plus this organisation's live registry rows, and
 * every model from the Ledger catalogue the model picker reads — so a tool or a
 * field added anywhere is in the Designer's knowledge the deploy it ships,
 * rather than the next time somebody remembers to edit a prompt. This is the
 * same discipline as the research-routing and agent-documents blocks; it is
 * bigger only because the subject is.
 *
 * Assembled for global-agent runs only: it is large, and no other agent designs
 * agents.
 *
 * Spec: docs/plans/2026-09-02-agent-designer-global-agent.md (D5).
 */

export type GlobalAgentCatalogueFacts = {
  catalogue: AgentToolCatalog
  /** Null when the model catalogue could not be read; never a stale guess. */
  models: AgentModelOption[] | null
  /** True when this run actually holds the create/update verbs. */
  hasIdentityTools: boolean
}

const MODEL_SHORTLIST = 20

const bullet = (line: string): string => `- ${line}`

const describeTool = (entry: AgentToolCatalogEntry): string =>
  bullet(
    `${entry.key} (${entry.label}) — ${entry.summary} `
    + `[${entry.allowMode ? 'off by default; set true' : 'on by default; set false to remove'}`
    + `${entry.requiresTodos ? '; needs todosEnabled' : ''}]`,
  )

const RESTRICTION_LABEL: Record<
  AgentToolCatalogRestrictedEntry['restriction'],
  string
> = {
  explicit_grant: 'owner surfaces only (Apps / Integrations)',
  personal_assistant_only: 'Personal Assistant only',
}

const describeRestricted = (entry: AgentToolCatalogRestrictedEntry): string =>
  bullet(`${entry.key} — ${RESTRICTION_LABEL[entry.restriction]}`)

const parametersSection = (): string[] => [
  'Agent parameters, exactly as the product stores them:',
  bullet('name, role — free text; role is a short label like "researcher".'),
  bullet(
    'systemPrompt — the agent\'s standing instructions. This is the craft: '
    + 'write what it does, how it decides, what it must not do.',
  ),
  bullet(
    `visibility — ${AgentVisibilitySchema.options.join(' | ')}. Set at creation `
    + 'and IMMUTABLE afterwards. A private agent belongs to its owner alone: it '
    + 'lives in an owner-only home conversation, cannot be bound to any channel, '
    + 'and cannot be transferred.',
  ),
  bullet(
    'provider + model — an exact pair from the deployment catalogue, sent '
    + 'together. Omit both to run on the organisation\'s default.',
  ),
  bullet(
    `effort — ${AgentEffortSchema.options.join(' | ')}. It maps to the `
    + 'provider\'s reasoning effort ONLY; it is not a spend setting.',
  ),
  bullet(
    `runLimits — optional per-run caps (${Object.keys(AgentRunLimitsSchema.shape).join(', ')}) `
    + 'over the deployment backstop. Omit for the backstop.',
  ),
  bullet(
    'todosEnabled — organisation owners only. It authorises trigger-driven '
    + 'work, which is a wider blast radius than wording a prompt.',
  ),
  bullet(
    'toolPolicy — a sparse map of tool key to boolean. Built-in tools are ON '
    + 'unless the policy says false; connector tools and explicit-grant tools '
    + 'are OFF unless the policy says true.',
  ),
  bullet(
    'avatar — generated automatically at creation; replaceable with an '
    + 'attachment afterwards.',
  ),
  bullet(
    'bindings — which channels an agent works in. Organisation owners only, '
    + 'and only channels they belong to; system conversations and private '
    + 'agents are refused.',
  ),
  bullet(
    `triggers — ${AgentTriggerTypeSchema.options.join(' | ')}. Scheduled and `
    + 'interval triggers need the creator to have a live SSO identity, because '
    + 'every future run re-uses it.',
  ),
]

const neverSection = (): string[] => [
  'What nobody can do from here, stated as facts rather than preferences:',
  bullet(
    'Explicit-grant tools (deep research, DeepWater, browser, mailbox and '
    + 'calendar, and any connector marked as needing a grant) are server-owned. '
    + 'They are granted from the owner surfaces. Name them and point there.',
  ),
  bullet(
    'Nessie\'s own agents — the Personal Assistant, and built-in ones like you '
    + '— are defined by the deployment. Nobody edits them, organisation owners '
    + 'included.',
  ),
  bullet('visibility cannot change after an agent is created.'),
  bullet(
    'A private agent belongs to one person: no channel binding, no transfer, '
    + 'and nobody else — not even an organisation owner — can see it.',
  ),
  bullet(
    'agentKind, systemManaged, surfacePolicy, delegationMode, executionMode '
    + 'and parentAgentId are set by the server. There is no way to ask for them.',
  ),
]

const modelSection = (models: AgentModelOption[] | null): string[] => {
  if (models === null) {
    return [
      'The model catalogue could not be read just now. Leave provider and model '
      + 'unset so the agent runs on the organisation default, and say so.',
    ]
  }
  if (models.length === 0) {
    return [
      'This deployment lists no selectable models. Leave provider and model '
      + 'unset; the agent runs on the organisation default.',
    ]
  }
  const shown = models.slice(0, MODEL_SHORTLIST)
  return [
    `Models available here (${models.length}${
      models.length > shown.length ? `, first ${shown.length} shown` : ''
    }); provider and model are one exact pair:`,
    ...shown.map((option) =>
      bullet(`${option.provider}/${option.model} — ${option.displayName}`)),
  ]
}

export const buildGlobalAgentCatalogueBlock = (
  facts: GlobalAgentCatalogueFacts,
): string => {
  const groups = new Map<string, AgentToolCatalogEntry[]>()
  for (const entry of facts.catalogue.togglable) {
    groups.set(entry.group, [...(groups.get(entry.group) ?? []), entry])
  }

  const toolLines = [...groups.entries()].flatMap(([group, entries]) => [
    `${group}:`,
    ...entries.map(describeTool),
  ])

  return [
    'Agent design catalogue (generated from this workspace, not remembered):',
    '',
    ...parametersSection(),
    '',
    `Tools you can give an agent (${facts.catalogue.togglable.length}), by tool `
    + 'policy key:',
    ...toolLines,
    '',
    ...(facts.catalogue.restricted.length > 0
      ? [
          'Tools that exist but are not yours to grant — name them and say '
          + 'where they come from:',
          ...facts.catalogue.restricted.map(describeRestricted),
          '',
        ]
      : []),
    ...modelSection(facts.models),
    '',
    ...neverSection(),
    '',
    facts.hasIdentityTools
      ? 'You can create and change agents yourself in this conversation. Use '
        + 'agent_read before agent_update so you change one field rather than '
        + 'overwrite an agent, and say what you created or changed and where it '
        + 'lives.'
      : 'You cannot create or change agents in this conversation. Hand the '
        + 'person the finished wording and point them at the Agent Designer '
        + 'page; never imply you did work you did not do.',
  ].join('\n')
}

/** The tool ids whose presence means this run can actually write agents. */
const IDENTITY_WRITE_TOOL_IDS = ['agent_create', 'agent_update']

/**
 * Assemble the block for a run, or null when the run's agent is not a global
 * agent. Best-effort throughout: the model catalogue is a network read, and a
 * design conversation is still worth having without it.
 */
export const loadGlobalAgentCatalogueBlock = async (
  prisma: PrismaClient,
  context: RunContext,
  input: {
    actorContext: AuthorizedActionContext
    ledgerIdentity: LedgerIdentityService | null
    resolvedToolIds: ReadonlySet<string>
  },
): Promise<string | null> => {
  const blueprint = getGlobalAgentBlueprint(context.agent.systemSlug)
  if (!blueprint) return null

  const [catalogue, models] = await Promise.all([
    loadAgentToolCatalog(prisma, {
      organizationId: context.channel.organizationId,
    }),
    listLedgerAgentModels({
      config: loadConfig().model,
      ...(process.env.LEDGER_PUBLIC_URL
        ? { ledgerPublicUrl: process.env.LEDGER_PUBLIC_URL }
        : {}),
      requestHeaders: await ledgerAgentModelCatalogRequestHeaders({
        actorContext: input.actorContext,
        ledgerIdentity: input.ledgerIdentity,
      }).catch(() => ({})),
    }).catch(() => null),
  ])

  return buildGlobalAgentCatalogueBlock({
    catalogue,
    hasIdentityTools: IDENTITY_WRITE_TOOL_IDS.some((toolId) =>
      input.resolvedToolIds.has(toolId)),
    models,
  })
}
