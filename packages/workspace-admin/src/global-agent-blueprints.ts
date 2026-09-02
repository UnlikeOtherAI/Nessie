import type { AgentEffort, AgentRunLimits } from '@nessie/schemas'

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

const AGENT_DESIGNER_PROMPT = [
  'You are the Agent Designer, the built-in specialist for shaping agents in',
  'this workspace. Your job is to understand what the person actually wants an',
  'agent to do — the work itself, the specialist tasks inside it, how often it',
  'runs, and what it needs to reach — and to help them turn that into a clear,',
  'concrete design: a name, a role, a system prompt that reads like real',
  'instructions, and the smallest set of capabilities that does the job.',
  '',
  'Ask the next real question rather than working through a questionnaire.',
  'Propose a complete draft early and improve it with them instead of',
  'collecting requirements first. Answer at colleague length: lead with the',
  'answer, plain prose, no headers or bullet lists unless the content genuinely',
  'is a list.',
  '',
  'You can create the agent yourself, and the channel it works in, and the',
  'schedule it runs on — acting as the person you are talking to, with exactly',
  'their authority and no more. Confirm the design in words first, then create',
  'it and say what you made and where it lives. If something is refused,',
  'relay the refusal as it is; never imply you did work you did not do.',
  '',
  'You cannot change an agent that already exists, and you cannot edit your own',
  'configuration. Say so plainly and point at the Agent Designer page instead.',
].join('\n')

export const AGENT_DESIGNER_SLUG = 'agent-designer'

export const AGENT_DESIGNER_BLUEPRINT: GlobalAgentBlueprint = {
  slug: AGENT_DESIGNER_SLUG,
  name: 'Agent Designer',
  role: 'agent designer',
  buildSystemPrompt: () => AGENT_DESIGNER_PROMPT,
  // Deny-mode narrowing only. A design conversation needs neither fan-out verb,
  // and keeping them off keeps the (eventually catalogue-laden) context from
  // multiplying. Everything else safe stays on by default; explicit-grant tools
  // are off by default and PA-only tools are structurally denied to it today.
  toolPolicy: {
    delegate: false,
    spawn_subtask: false,
    // Builtins are deny-mode, so these entries change nothing on their own —
    // the `personalAssistantOnly` gate is what admits them, and it reads
    // `identityToolIds` below. They are written explicitly anyway so the stored
    // row states the intent, and so revoking one is a single `false`.
    agent_bind_channel: true,
    agent_create: true,
    agent_list: true,
    agent_trigger_create: true,
    channel_create: true,
  },
  // The identity-delegated set (D3): each is `personalAssistantOnly`, each
  // mirrors one route's authorization exactly, and each acts as the sole member
  // of the home DM this agent is running in.
  identityToolIds: [
    'agent_list',
    'agent_create',
    'agent_bind_channel',
    'agent_trigger_create',
    'channel_create',
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
