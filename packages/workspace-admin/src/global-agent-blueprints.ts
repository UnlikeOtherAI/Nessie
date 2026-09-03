import { AGENT_DESIGNER_SLUG, type AgentEffort, type AgentRunLimits } from '@nessie/schemas'

/**
 * Global agents — app-provided, instantiated per organisation.
 *
 * "Provided by the app" means a blueprint in code, never a cross-org row: every
 * read path scopes by `organizationId`, so a shared row would be the
 * flatten-several-orgs violation the UOA invariant names, this time for agents.
 * The blueprint is the definition; bootstrap turns it into one `systemManaged`
 * `Agent` row per organisation, keyed by `Agent.systemSlug`, and updates ship by
 * redeploy (`ensureGlobalAgent` re-applies the blueprint under the per-agent
 * policy lock).
 *
 * Spec: docs/plans/2026-09-02-agent-designer-global-agent.md (D1).
 */

export type GlobalAgentPromptContext = {
  organizationId: string
}

export type GlobalAgentBlueprint = {
  /** Durable discriminator. One row per `(organizationId, slug)`. */
  slug: string
  /** Display name for the agent and its home DM. */
  name: string
  role: string
  /**
   * One sentence naming the work this specialist owns, in the second person as
   * another agent would read it. It is the entire content of the `agent_handoff`
   * routing block every other agent carries (D8), so it is written here — once,
   * beside the blueprint — rather than restated in a prompt string a new global
   * agent could be forgotten from.
   */
  handoffSummary: string
  /**
   * The stored system prompt. Phase 1 is a short persona; the generated
   * capability catalogue (D5) is assembled at run setup in phase 2.
   */
  buildSystemPrompt: (context: GlobalAgentPromptContext) => string
  /**
   * Blueprint tool policy. Builtins are deny-mode (allowed unless the policy
   * says `false`), so this is where a global agent *narrows* its toolset. It is
   * passed through `assertGenericAgentToolPolicyInput` exactly like user input:
   * vendor config cannot smuggle a protected explicit-grant key either.
   */
  toolPolicy: Record<string, boolean>
  /**
   * `personalAssistantOnly` tools this blueprint may exercise on its own home
   * DM.
   *
   * The `personalAssistantOnly` gate admits one of these only when the run is
   * on this blueprint's own home DM AND is an interactive turn from a live
   * human requester (`resolveIdentityDelegatedToolIds` in the worker). Neither
   * an agent's stored policy nor the model can add to this list — it ships with
   * the deployment.
   */
  identityToolIds: readonly string[]
  /** Null ⇒ the organisation's default model (the Librarian's cost stance). */
  provider?: string | null
  model?: string | null
  effort: AgentEffort
  runLimits?: AgentRunLimits
  /** v1: DM-homed only. The run-start assertion reads this. */
  home: 'per_user_dm'
  /**
   * v1 global agents own no automation: a scheduled run would re-arm an absent
   * creator's identity, and identity-delegated tools must never reach an
   * unattended run. `createAgentTrigger` refuses a `systemSlug` target.
   */
  allowsSelfTriggers: false
  /**
   * A stable tile colour so the agent reads as intentional before anyone spends
   * a billed image generation on it. Avatar *images* follow the Personal
   * Assistant's own lazy, owner-triggered path rather than a bootstrap call.
   */
  avatarBackgroundColor?: string
}

/**
 * The persona half of the prompt. Deliberately short and goal-shaped: the
 * catalogue of what an agent CAN be is generated at run setup (D5), and the
 * shape of any given setup conversation is the model's judgement in the
 * person's own language — so there are no scripted flows and no example
 * questions here, the same rule that keeps intent model-judged everywhere else.
 */
const AGENT_DESIGNER_PROMPT = [
  'You are the Agent Designer, the built-in specialist for shaping agents in',
  'this workspace. Your job is to understand what the person wants an agent to',
  'DO — the work itself, the specialist tasks inside it, how often it should',
  'run, and what it needs to reach — and then to build it.',
  '',
  'Understand the work before you configure anything. What an agent needs is a',
  'consequence of the job: a prompt that reads like real instructions to a',
  'colleague, the smallest set of tools that does that job, a cadence if the',
  'work recurs, and a place to do it. Ask the next real question — the one you',
  'genuinely need answered to go further — rather than working through a',
  'questionnaire. When you understand enough, propose a complete draft and',
  'improve it with them; a concrete draft they can react to is worth more than',
  'three more questions.',
  '',
  'You can create the agent yourself, the channel it works in, the project and',
  'team that channel lives inside, and the schedule it runs on — acting as the',
  'person you are talking to, with exactly their authority and no more.',
  'Creating a project or a team is an organisation owner\'s action; when they',
  'are not one, relay the refusal as it is and say who can. You can also',
  'reshape an agent that already exists when they are allowed to edit it; when',
  'they are not, relay that refusal too. You can never edit your own',
  'configuration: you are one of Nessie\'s built-in agents.',
  '',
  'Confirm before you create something consequential, and make it a question',
  'they can answer with one word rather than a form. Say what you are about to',
  'make and who will be able to see it. Unless they have said otherwise, what',
  'you stand up for someone is theirs alone — a project, a team and a channel',
  'created on their say-so start with them in it and nobody else, so a channel',
  'anyone in the workspace could find is something to ask about, never to',
  'assume. Once they have agreed, do the whole thing; do not re-ask at every',
  'step.',
  '',
  'Name the tools by what they let the agent do, never as an inventory. If',
  'something they want needs a capability nobody can grant from a conversation,',
  'say what it is and where it is granted instead of quietly leaving it out.',
  '',
  'When you create or change something, say what you did and where it lives —',
  'link the conversation or channel it landed in — and never imply you did work',
  'you did not do.',
  '',
  'Use a card when a structured answer genuinely beats prose: a yes/no',
  'confirmation, a choice from a short list, or a few short fields at once. A',
  'question that fits in a sentence is fine as a sentence. Post it WITHOUT wait so the',
  'person can press it or simply answer in chat, whichever suits them; a',
  'waiting card holds the conversation and pends everything they type behind',
  'it. Reserve wait for a step that truly cannot proceed without a structured',
  'answer, and always give such a card an expiry. Everything else is ordinary',
  'chat: lead with the answer, plain prose, no headers or bullet lists unless',
  'the content genuinely is a list.',
].join('\n')

export { AGENT_DESIGNER_SLUG }

export const AGENT_DESIGNER_BLUEPRINT: GlobalAgentBlueprint = {
  slug: AGENT_DESIGNER_SLUG,
  name: 'Agent Designer',
  role: 'agent designer',
  handoffSummary:
    'designing, creating and reshaping agents — what an agent should do, what it '
    + 'needs access to, the channel it works in and the schedule it runs on',
  buildSystemPrompt: () => AGENT_DESIGNER_PROMPT,
  // Deny-mode narrowing only. A design conversation needs neither fan-out verb,
  // and keeping them off keeps the (eventually catalogue-laden) context from
  // multiplying. Everything else safe stays on by default; explicit-grant tools
  // are off by default and PA-only tools are structurally denied to it today.
  toolPolicy: {
    agent_avatar_update: true,
    agent_bind_channel: true,
    agent_create: true,
    agent_list: true,
    agent_read: true,
    agent_tool_catalog: true,
    agent_trigger_create: true,
    agent_update: true,
    channel_create: true,
    project_create: true,
    project_list: true,
    team_create: true,
    // Builtins are deny-mode, so the `true`s above change nothing on their own —
    // the `personalAssistantOnly` gate is what admits them, and it reads
    // `identityToolIds` below. They are written explicitly anyway so the stored
    // row states the intent, and so revoking one is a single `false`.
    delegate: false,
    spawn_subtask: false,
  },
  // The identity-delegated set (D3): each is `personalAssistantOnly`, each
  // mirrors one route's authorization exactly, and each acts as the sole member
  // of the home DM this agent is running in. The gate arm that reads this
  // widens `personalAssistantOnly` structurally rather than forking
  // designer-only copies of the tools.
  identityToolIds: [
    'agent_avatar_update',
    'agent_bind_channel',
    'agent_create',
    'agent_list',
    'agent_read',
    'agent_tool_catalog',
    'agent_trigger_create',
    'agent_update',
    'channel_create',
    // The containers a channel needs, plus the read that resolves a project or
    // team NAME to its id. Both writes are organisation-owner actions and say
    // so to anybody else, exactly as their routes do.
    'project_create',
    'project_list',
    'team_create',
  ],
  provider: null,
  model: null,
  effort: 'medium',
  home: 'per_user_dm',
  allowsSelfTriggers: false,
  avatarBackgroundColor: '#4c5fd7',
}

const BLUEPRINTS: readonly GlobalAgentBlueprint[] = [AGENT_DESIGNER_BLUEPRINT]

export const GLOBAL_AGENT_BLUEPRINTS: ReadonlyMap<string, GlobalAgentBlueprint> =
  new Map(BLUEPRINTS.map((blueprint) => [blueprint.slug, blueprint]))

export const listGlobalAgentBlueprints = (): readonly GlobalAgentBlueprint[] =>
  BLUEPRINTS

export const getGlobalAgentBlueprint = (
  slug: string | null | undefined,
): GlobalAgentBlueprint | null =>
  (slug ? GLOBAL_AGENT_BLUEPRINTS.get(slug) ?? null : null)

/**
 * The home DM key. The encoded user is segment 4 — the database trigger parses
 * exactly this position to prove the DM holds only that person.
 */
export const globalAgentHomePrefix = (input: {
  organizationId: string
  slug: string
}): string => `gagent:${input.slug}:${input.organizationId}:`

export const globalAgentHomeDmKey = (input: {
  organizationId: string
  slug: string
  userId: string
}): string => `${globalAgentHomePrefix(input)}${input.userId}`

/**
 * Blueprint pin, else the deployment's designer override, else the
 * organisation's default model. One rule, so the DM face and the Agent Designer
 * page's sidebar face cannot resolve different models (D1/D9).
 */
export const resolveGlobalAgentModel = (
  blueprint: GlobalAgentBlueprint,
): { model: string | null; provider: string | null } => {
  if (blueprint.model) {
    return { model: blueprint.model, provider: blueprint.provider ?? null }
  }
  if (blueprint.slug === AGENT_DESIGNER_SLUG) {
    const override = process.env['NESSIE_DESIGNER_MODEL']?.trim()
    if (override) {
      return { model: override, provider: blueprint.provider ?? null }
    }
  }
  return { model: null, provider: blueprint.provider ?? null }
}
