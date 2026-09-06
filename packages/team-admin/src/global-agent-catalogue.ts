import {
  AgentEffortSchema,
  AgentRunLimitsSchema,
  AgentTriggerTypeSchema,
  AgentVisibilitySchema,
  type AgentModelOption,
} from '@nessie/schemas'

import type {
  AgentToolCatalog,
  AgentToolCatalogEntry,
  AgentToolCatalogRestrictedEntry,
  AgentToolRestriction,
} from './agent-tool-catalog.js'

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
 * It lives in `@nessie/team-admin` because the Designer has two faces and
 * one brain: the worker assembles it for a run in the home DM, and the API
 * assembles it for the Agent Designer page's sidebar. `api/src/services/*` is
 * unreachable from the worker and vice versa, so a builder in either process
 * would have become two personas within a release (D9).
 *
 * Spec: docs/plans/2026-09-02-agent-designer-global-agent.md (D5, D9).
 */

export type GlobalAgentCatalogueFacts = {
  catalogue: AgentToolCatalog
  /** Null when the model catalogue could not be read; never a stale guess. */
  models: AgentModelOption[] | null
  /**
   * The look this person's generated portraits are drawn in.
   *
   * Three states, deliberately: a string is the style in force, `null` is
   * "resolved, and nobody has chosen one", and **absent** is "this face did
   * not resolve it" — the page's sidebar fills a form and draws no pictures.
   * Collapsing absent into null would have the block tell the model somebody
   * has never chosen a style when they have.
   */
  avatarStyle?: string | null
  /**
   * How this face of the Designer actually changes an agent, which decides the
   * one closing instruction. The two transports genuinely differ — the DM holds
   * the write tools, the sidebar drives the open form control-by-control — and
   * saying so is the difference between a truthful capability claim and the
   * "never imply you did work you did not do" rule being broken by the prompt
   * itself.
   */
  writeSurface: 'agent_tools' | 'designer_form' | 'read_only'
}

const MODEL_SHORTLIST = 20

const bullet = (line: string): string => `- ${line}`

const describeTool = (entry: AgentToolCatalogEntry): string =>
  bullet(
    `${entry.key} (${entry.label}) — ${entry.summary} `
    + `[${entry.allowMode ? 'off by default; set true' : 'on by default; set false to remove'}`
    + `${entry.requiresTodos ? '; needs todosEnabled' : ''}]`,
  )

const RESTRICTION_LABEL: Record<AgentToolRestriction, string> = {
  built_in_specialist_only: 'reserved for Nessie\'s built-in specialists',
  explicit_grant: 'owner surfaces only (Apps / Integrations)',
  personal_assistant_only: 'Personal Assistant only',
}

const describeRestricted = (entry: AgentToolCatalogRestrictedEntry): string =>
  bullet(`${entry.key} — ${RESTRICTION_LABEL[entry.restriction]}`)

const avatarLine = (facts: GlobalAgentCatalogueFacts): string => {
  const drawing = facts.writeSurface === 'agent_tools'
    ? 'a portrait is generated automatically at creation, and '
      + 'agent_avatar_generate draws a replacement in a style they name.'
    : 'a portrait is generated automatically at creation; it can be replaced '
      + 'with a generated or uploaded one afterwards.'
  if (facts.avatarStyle === undefined) return bullet(`avatar — ${drawing}`)
  // The style itself is NOT written here. This block is assembled into a
  // system prompt, which is instruction position, and a style is free text a
  // person types — an organisation-level one reaching every member's run. The
  // words travel where they are data: the image prompt's user message, and
  // the tool result that says what was drawn.
  return bullet(
    `avatar — ${drawing} `
    + (facts.avatarStyle
      ? 'This person has already chosen the look their portraits are drawn '
        + 'in and it is applied automatically, so pass a style only when they '
        + 'ask for a different one.'
      : 'This person has never chosen a style, so portraits use the default '
        + 'look until they say what they like — the style they state is '
        + 'remembered for every portrait after it.'),
  )
}

const parametersSection = (avatarLineText: string): string[] => [
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
  avatarLineText,
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

const WRITE_SURFACE_LINE: Record<
  GlobalAgentCatalogueFacts['writeSurface'],
  string
> = {
  agent_tools:
    'You can create and change agents yourself in this conversation. Use '
    + 'agent_read before agent_update so you change one field rather than '
    + 'overwrite an agent, and say what you created or changed and where it '
    + 'lives.',
  designer_form:
    'You are working inside the Agent Designer page, so you change the agent by '
    + 'filling in the form in front of the person — that is what your tools do. '
    + 'The form is not saved until they save it, so never say an agent has been '
    + 'created or changed; say what you have set up for them to save.',
  // This is the shared-channel case: a global agent bound into an ordinary
  // room has the catalogue but not the identity-delegated write verbs, which
  // stay gated on its own home DM. It advises here and says where the work
  // actually happens.
  read_only:
    'You cannot create or change agents in this conversation — you are in a '
    + 'shared channel, and building an agent happens in your own private chat '
    + 'with the person, where you act with their authority. Work the design out '
    + 'with them here, then tell them to continue in that chat (or on the Agent '
    + 'Designer page) to have it built; never imply you did work you did not do.',
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
    'Agent design catalogue (generated from this team, not remembered):',
    '',
    ...parametersSection(avatarLine(facts)),
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
    WRITE_SURFACE_LINE[facts.writeSurface],
  ].join('\n')
}
