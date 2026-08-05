// Research routing (spec §9).
//
// Which research path an agent should reach for is decided from STRUCTURAL
// facts only — which tools the toolset actually assembled, and whether this is
// a DeepWater launch turn. Nothing here inspects message content: whether the
// user is asking for deep research, and whether they already consented, is the
// model's judgment, made from the conversation it can see.

export type ResearchRoutingFacts = {
  hasDelegate: boolean
  hasResearchTools: boolean
  hasWebSearch: boolean
  isHandoffTurn: boolean
}

const DEEP_WATER_BLOCK = [
  'Research routing:',
  '- For deep, multi-source research, offer a DeepWater research run first'
    + ' (mcp_research_start). It is slower and runs as a metered external job, so get'
    + ' the user\'s go-ahead in this thread before starting one. If they have already'
    + ' agreed — or already declined — in this conversation, honour that instead of'
    + ' asking again.',
  '- Once a research job is running, mcp_research_status / mcp_research_report follow'
    + ' it up; do not start a second job for the same question.',
  '- For quick lookups and single facts, use web_search directly. Do not spend a'
    + ' research run on something one search answers.',
].join('\n')

const SELF_RESEARCH_BLOCK = [
  'Research routing:',
  '- Do the research yourself with web_search: search, open what matters, and keep'
    + ' the exact numbers, names, and URLs you rely on.',
  '- Cite sources with the URL as you saw it. Never present a source you did not read.',
].join('\n')

const DELEGATE_LINE = [
  '- For broad discovery, fan the search out with delegate: one sub-agent per angle,'
    + ' each returning a short digest rather than raw pages. Keep the digests, not the'
    + ' transcripts.',
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
  if (facts.hasResearchTools) return DEEP_WATER_BLOCK
  if (!facts.hasWebSearch) return null
  return facts.hasDelegate
    ? `${SELF_RESEARCH_BLOCK}\n${DELEGATE_LINE}`
    : SELF_RESEARCH_BLOCK
}
