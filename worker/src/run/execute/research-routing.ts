// Research routing (spec §9; Water plan nessie.md §7.6, amendments N7, F8).
//
// Which research path an agent should reach for is decided from STRUCTURAL
// facts only — which tools the toolset actually assembled, and whether this is
// a DeepWater launch turn. Nothing here inspects message content: whether the
// user is asking for deep research, and whether they already consented, is the
// model's judgment, made from the conversation it can see.
//
// The block names only the DeepWater tools this run was actually given, so it
// never points the model at a tool it cannot call.

export type ResearchRoutingFacts = {
  hasDelegate: boolean
  /** Ledger tool names of the managed DeepWater tools that reached this run (`research_*`). */
  researchTools: ReadonlySet<string>
  /** `card_post` reached this run, so the agent can ask the person and wait. */
  hasCardPost: boolean
  hasWebSearch: boolean
  isHandoffTurn: boolean
}

const CONSENT = 'Research is slower and runs as a metered job, so get the person\'s go-ahead in this thread'
  + ' first; if they have already agreed — or already declined — in this conversation, honour that instead'
  + ' of asking again.'

const PRIVATE_REFUSAL = '- If a DeepWater tool is refused because this conversation is private, do not retry.'
  + ' Tell the person you cannot send this conversation to DeepWater, and that they can start the research'
  + ' themselves with the Research button in this chat.'

const WEB_SEARCH_LINE = '- For quick lookups and single facts, use web_search directly. Do not spend a'
  + ' research run on something one search answers.'

/** The brief-first contract: agree a brief with DeepWater's planner, then launch it. */
const briefBlock = (facts: ResearchRoutingFacts): string => {
  const has = (name: string) => facts.researchTools.has(name)
  const lines = [
    'Research routing:',
    '- For deep, multi-source research, agree a brief with DeepWater\'s research planner first: open it with'
      + ' mcp_research_scope_start, giving the question, any background, and the pillars or settings the person'
      + ` already asked for. ${CONSENT}`,
    '- The planner answers later, and you will be woken in this thread when it does. Do not poll for it and'
      + ' do not wait on it: tell the person the planner is working, then end your turn.',
  ]
  if (has('research_scope_get') && has('research_scope_reply')) {
    lines.push('- When you are woken, read the brief with mcp_research_scope_get (set include_transcript only'
      + ' when you need the whole conversation), then answer the planner with mcp_research_scope_reply.')
  }
  if (facts.hasCardPost) {
    lines.push('- Ask the person with card_post and wait: true only for questions only they can answer;'
      + ' settle everything else with the planner yourself.')
  }
  if (has('research_scope_launch')) {
    lines.push('- Launch the agreed brief with mcp_research_scope_launch at the brief\'s current revision.'
      + ' Never start a second research for the same question.')
  }
  lines.push('- A launched research comes back to you in this thread when it finishes'
    + (has('research_status') || has('research_report')
      ? '; mcp_research_status and mcp_research_report are for when the person asks about it.'
      : '.'))
  lines.push(PRIVATE_REFUSAL)
  if (facts.hasWebSearch) lines.push(WEB_SEARCH_LINE)
  return lines.join('\n')
}

/** A team still on the launcher contract (manifest 0.2) until its owner updates DeepWater. */
const LAUNCHER_BLOCK = [
  'Research routing:',
  `- For deep, multi-source research, offer a DeepWater research run first (mcp_research_start). ${CONSENT}`,
  '- Once a research job is running, mcp_research_status / mcp_research_report follow'
    + ' it up; do not start a second job for the same question.',
  WEB_SEARCH_LINE,
].join('\n')

const SELF_RESEARCH_BLOCK = [
  'Research routing:',
  '- Do the research yourself with web_search: search, open what matters, and keep'
    + ' the exact numbers, names, and URLs you rely on.',
  '- Cite sources with the URL as you saw it. Never present a source you did not read.',
].join('\n')

const DELEGATE_LINE = [
  '- Default to delegate for discovery: fan the searches and fetches out, one sub-agent'
    + ' per angle, and keep only the digests they hand back. Raw pages and search'
    + ' transcripts stay out of this conversation.',
  '- Look something up yourself when a single search settles it; delegate when it takes'
    + ' several.',
  '- A sub-agent that fails or returns nothing is a gap in your coverage, not a source.'
    + ' Say so, or cover it yourself.',
].join('\n')

/**
 * At most one routing block, appended to the system prompt.
 *
 * A DeepWater launch turn gets NO block: the server authored that prompt, and
 * `delegate` is blocked for the duration of the launch, so suggesting either
 * would be wrong.
 */
export const buildResearchRoutingBlock = (
  facts: ResearchRoutingFacts,
): string | null => {
  if (facts.isHandoffTurn) return null
  if (facts.researchTools.has('research_scope_start')) return briefBlock(facts)
  if (facts.researchTools.has('research_start')) return LAUNCHER_BLOCK
  if (!facts.hasWebSearch) return null
  return facts.hasDelegate
    ? `${SELF_RESEARCH_BLOCK}\n${DELEGATE_LINE}`
    : SELF_RESEARCH_BLOCK
}
