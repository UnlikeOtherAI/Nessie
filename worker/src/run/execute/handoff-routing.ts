import { listGlobalAgentBlueprints } from '@nessie/workspace-admin'

/**
 * Handoff routing (D8) — the research-routing precedent, one level over.
 *
 * Every agent that can talk carries one structural line saying which work
 * belongs to a built-in specialist and that `agent_handoff` is how it gets
 * there. Like the research block, it is derived from STRUCTURAL facts only —
 * whether the toolset actually assembled `agent_handoff`, and whether this run's
 * own agent is a global agent — and never from message content. *Whether* a
 * given request is that specialist's job stays the model's judgement, made from
 * the conversation in the person's own language.
 *
 * The specialist list is rendered from the blueprint registry rather than
 * written out, so a second global agent is in every agent's knowledge the deploy
 * it ships — the same discipline as the agent-documents and to-do blocks.
 */

export type HandoffRoutingFacts = {
  /** True when `agent_handoff` survived toolset assembly for this run. */
  hasHandoffTool: boolean
}

export const buildHandoffRoutingBlock = (
  facts: HandoffRoutingFacts,
): string | null => {
  // A global agent never sees the tool at all (`authorizeToolCall` withholds it
  // from any row carrying a `systemSlug`), so keying on the resolved toolset
  // covers the destination side too — there is no second condition to forget.
  if (!facts.hasHandoffTool) return null

  const specialists = listGlobalAgentBlueprints()
  if (specialists.length === 0) return null

  return [
    'Built-in specialists:',
    ...specialists.map((blueprint) =>
      `- The ${blueprint.name} (\`${blueprint.slug}\`) handles ${blueprint.handoffSummary}.`
      + ' That work is not yours.',
    ),
    '- When someone asks you for one of those, answer in your own words that it'
      + ' belongs to that specialist, then call agent_handoff with a brief of what'
      + ' they want and what you already know. It opens their own private chat with'
      + ' that specialist; say where the conversation continues.',
    '- Do not attempt the work yourself first, and do not hand off for anything'
      + ' outside those descriptions — for everything else you are the right agent.',
  ].join('\n')
}
