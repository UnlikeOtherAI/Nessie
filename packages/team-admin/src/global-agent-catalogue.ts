import {
  AgentEffortSchema,
  AgentRunLimitsSchema,
  AgentTriggerTypeSchema,
  AgentVisibilitySchema,
  type AgentModelOption,
} from '@nessie/schemas'
import { buildBrowserbaseSetupPrompt } from '@nessie/runtime'
import type { GlobalAgentExecutorFacts } from '@nessie/executor-manage'

import {
  executorSection,
  type GlobalAgentCatalogueWriteSurface,
} from './global-agent-executor-catalogue.js'

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
  /**
   * Every executor the requesting person is entitled to see, with the detail
   * their own access affords. Three states, exactly as `models` has them and
   * for the same reason: `null` is "could not be read just now" and is said
   * out loud rather than guessed at, `[]` is "this deployment has none you can
   * reach", and an array is the live list. This is the ONLY way the page's
   * sidebar face ever learns an executor exists — it holds no read tools.
   */
  executors: GlobalAgentExecutorFacts[] | null
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
  writeSurface: GlobalAgentCatalogueWriteSurface
  /**
   * The protected-access verbs this run resolved. Absent is "none", which is
   * what every face that only advises should say.
   */
  protectedAccess?: GlobalAgentProtectedAccessFacts
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
  explicit_grant: 'owner approval required (the agent Tools tab or an app access surface)',
  personal_assistant_only: 'Personal Assistant only',
}

const describeRestricted = (entry: AgentToolCatalogRestrictedEntry): string =>
  bullet(`${entry.key} — ${RESTRICTION_LABEL[entry.restriction]}`)

const describeGrantable = (entry: AgentToolCatalogRestrictedEntry): string =>
  bullet(`${entry.key} (${entry.label}) — ${entry.summary}`)

/**
 * The protected-access verbs this particular run holds.
 *
 * Whether an explicit-grant tool is "yours to give" is not a property of the
 * tool — it is a property of the agent reading this block. The Designer's own
 * home DM resolves the three verbs below and can grant with the person's
 * authority; the same catalogue rendered for a shared-channel face, or for any
 * other agent, resolves none of them and must keep pointing at the owner
 * surfaces. One blanket sentence cannot be true for both, and the blanket
 * "nobody can do this from here" is what had the Designer refuse work it was
 * holding the tools for.
 */
export type GlobalAgentProtectedAccessFacts = {
  /** `agent_deepwater_access_set` — the complete DeepWater bundle. */
  canSetDeepWater: boolean
  /** `agent_tool_access_inspect` — read the target agent's grants. */
  canInspect: boolean
  /** `agent_tool_access_set` — grant or revoke one protected tool. */
  canSet: boolean
}

const NO_PROTECTED_ACCESS: GlobalAgentProtectedAccessFacts = {
  canInspect: false,
  canSet: false,
  canSetDeepWater: false,
}

/**
 * How to actually use the grant verbs, stated only to a face that holds them.
 * Every line here is a fact the handlers enforce: the owner check in
 * `requireOwnerMember`, the registry-id argument, DeepWater's all-or-nothing
 * bundle, and the executor carve-out.
 */
const protectedGrantSection = (
  access: GlobalAgentProtectedAccessFacts,
): string[] => [
  'Explicit-grant tools you can grant yourself, with the person\'s own '
  + 'authority:',
  ...(access.canInspect
    ? [bullet(
        'agent_tool_access_inspect(agentId) first — it returns the exact '
        + 'registry id of every protected builtin and connected-app tool, and '
        + 'whether the agent already has it. Never guess an id.',
      )]
    : []),
  ...(access.canSet
    ? [bullet(
        'agent_tool_access_set(agentId, toolRegistryEntryId, enabled) grants or '
        + 'revokes one of them — browser tools and connector tools included.',
      )]
    : []),
  ...(access.canSetDeepWater
    ? [bullet(
        'agent_deepwater_access_set(agentId, teamId, enabled) moves the whole '
        + 'DeepWater research bundle at once. It cannot be granted one '
        + 'projection at a time, and it needs DeepWater enabled for the team '
        + 'with every explicit-grant tool ready — the tool says so when it is '
        + 'not.',
      )]
    : []),
  bullet(
    'These act as the person asking, so they are refused unless that person is '
    + 'an organisation owner. If the tool refuses, say what it said. Do not '
    + 'send an owner to the Tools tab for work you can do here.',
  ),
  bullet(
    'Executor logical tools are the exception: they are managed from the '
    + 'Executors access controls, not by these verbs.',
  ),
]

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
    'bindings — which channels an agent works in, one channel at a time. '
    + 'There is no project-wide or team-wide binding: a project and a team are '
    + 'where a channel lives, so "put it in the Sales project" is a set of '
    + 'channel bindings, and a channel added to that project afterwards will '
    + 'not have the agent in it. A binding is refused across teams once the '
    + 'agent has one. Organisation owners only, and only channels they belong '
    + 'to; system conversations and private agents are refused.',
  ),
  bullet(
    'direct messages — not a binding anybody arranges. Anyone who can reach a '
    + 'team-visible agent gets their own private conversation with it on '
    + 'demand, and a private agent has exactly one, its owner\'s.',
  ),
  bullet(
    `triggers — ${AgentTriggerTypeSchema.options.join(' | ')}. Scheduled and `
    + 'interval triggers need the creator to have a live SSO identity, because '
    + 'every future run re-uses it.',
  ),
]

const neverSection = (
  access: GlobalAgentProtectedAccessFacts,
): string[] => [
  'What nobody can do from here, stated as facts rather than preferences:',
  // Only true for a face without the grant verbs. With them, the grant section
  // above says how — and repeating this bullet there would be the prompt
  // telling the agent it cannot do the thing it is holding the tool for.
  ...(access.canSet
    ? []
    : [bullet(
        'Explicit-grant tools (deep research, DeepWater, browser, mailbox and '
        + 'calendar, and any connector marked as needing a grant) are '
        + 'server-owned. They are granted from the owner surfaces. Name them '
        + 'and point there.',
      )]),
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

const cloudBrowserSetupSection = (
  writeSurface: GlobalAgentCatalogueFacts['writeSurface'],
  access: GlobalAgentProtectedAccessFacts,
): string[] => [
  ...(writeSurface === 'designer_form'
    ? [bullet(
        'This page cannot post a masked credential form. If Browserbase setup '
        + 'is needed, explain it here and use Continue in chat to collect the key '
        + 'through the Agent Designer conversation.',
      )]
    : []),
  ...buildBrowserbaseSetupPrompt({
    canGrantBrowserTools: access.canSet,
    hasCardTool: writeSurface === 'agent_tools',
  })
    .split('\n')
    .map((line) => line === 'Cloud browser setup:' ? line : bullet(line)),
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

/**
 * The proposal card, described once, in the only transport that can post one.
 *
 * It lives here rather than in the blueprint persona because the persona is
 * shared by three faces and only this one holds `card_post`: the Agent Designer
 * page fills a form, and the shared-channel face writes nothing at all. Telling
 * either of those to post a card would be the prompt itself breaking the "never
 * imply you did work you did not do" rule.
 *
 * Standardised on purpose. A person who has read one of these should be able to
 * read the next at a glance, so the four things that are true of every agent —
 * what it is called, what it will do, where it lives, and what it can reach —
 * are always in the same place, and the agent's own additions go in the fold
 * rather than rearranging the card.
 */
const proposalCardSection = (): string[] => [
  'Proposing an agent: one card, always the same card.',
  bullet('title — the agent\'s name. subtitle — its role, two or three words.'),
  bullet(
    'message — your own words about this proposal, the sentence or two you '
    + 'would otherwise have typed into the chat. It renders above the card, in '
    + 'the same message, so the person reads it and the buttons as one thing.',
  ),
  bullet(
    'A text block of at most three lines saying what it will do. The work, '
    + 'not the machinery.',
  ),
  bullet(
    'A fields block for where it lives and who can see it — the team, project '
    + 'and channel it will work in, or that it is private to them.',
  ),
  bullet(
    'An input block, a select, for the model: a few from the catalogue above '
    + 'with your recommendation as the default. Each option\'s value is the '
    + 'provider and model as one pair, written exactly as the catalogue writes '
    + 'it. Ask for the model here and never in prose.',
  ),
  bullet(
    'A details block, which arrives closed, holding what they can check if '
    + 'they want to: a chips block naming the tools, a chips block naming the '
    + 'apps it will reach, and anything else this particular agent needs said. '
    + 'That fold is where your own blocks go — do not invent a different card '
    + 'because this one has no row for something.',
  ),
  bullet('Three actions: Accept, which submits, then Edit and Decline, which do not.'),
  'Post it without wait, so they can press it or simply answer in chat, and '
  + 'then end your turn without another word: the card carries your message, '
  + 'and a sentence after it is the same thing said twice. '
  + 'Accept means build exactly what the card says, on the model they picked, '
  + 'and then say where it landed. Edit means ask what they want different and '
  + 'post a fresh card. Decline means build nothing.',
]

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

  // An explicit-grant tool is only "not yours to grant" when this face cannot
  // grant it. Splitting the list by the verbs actually resolved is what keeps
  // both sentences true on the same catalogue.
  const access = facts.protectedAccess ?? NO_PROTECTED_ACCESS
  const grantable = access.canSet
    ? facts.catalogue.restricted.filter(
        (entry) => entry.restriction === 'explicit_grant',
      )
    : []
  const notGrantable = facts.catalogue.restricted.filter(
    (entry) => !grantable.includes(entry),
  )

  return [
    'Agent design catalogue (generated from this team, not remembered):',
    '',
    ...parametersSection(avatarLine(facts)),
    '',
    `Tools you can give an agent (${facts.catalogue.togglable.length}), by tool `
    + 'policy key:',
    ...toolLines,
    '',
    ...(grantable.length > 0
      ? [
          'Explicit-grant tools in this organisation, by registry key:',
          ...grantable.map(describeGrantable),
          '',
        ]
      : []),
    ...(access.canSet ? [...protectedGrantSection(access), ''] : []),
    ...(notGrantable.length > 0
      ? [
          'Tools that exist but are not yours to grant — name them and say '
          + 'where they come from:',
          ...notGrantable.map(describeRestricted),
          '',
        ]
      : []),
    ...modelSection(facts.models),
    '',
    ...executorSection(facts.executors, facts.writeSurface),
    '',
    ...(facts.writeSurface === 'agent_tools' ? [...proposalCardSection(), ''] : []),
    ...cloudBrowserSetupSection(facts.writeSurface, access),
    '',
    ...neverSection(access),
    '',
    WRITE_SURFACE_LINE[facts.writeSurface],
  ].join('\n')
}
