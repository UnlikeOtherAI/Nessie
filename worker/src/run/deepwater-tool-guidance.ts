/**
 * What an agent reads beside a DeepWater tool result, written by the run
 * binder (Water plan nessie.md §7.4, amendments N1.5, N7, amendments-fable F8).
 * Structural text only: it never quotes the brief, the planner or the report,
 * and names tools by the names the agent sees.
 */

/** After `research_scope_start` or `research_scope_reply` was accepted (F8). */
export const plannerWorkingGuidance = (researchId: string): string => [
  `DeepWater's research planner is working on this brief (research id ${researchId}).`,
  'You will be woken here when it answers — tell the person that now, then end your turn.',
  'Do not poll for the answer.',
].join(' ')

/**
 * `research_scope_start` threw or answered outside its contract: Ledger may
 * have opened the brief, and the watch finds it by replaying this very call
 * (N1.5). A second start would open a second brief.
 */
export const scopeStartUncertainGuidance = [
  'DeepWater did not confirm this research brief, but it may have started.',
  'You will be woken here when DeepWater\'s research planner answers.',
  'Do not call mcp_research_scope_start again for this request.',
].join(' ')

/**
 * Ledger refused `research_scope_launch` and put the brief back to drafting
 * (amendments L3): the research did not start.
 */
export const launchRefusedGuidance = [
  'DeepWater did not start this research, so its brief is still being agreed.',
  'Read it with mcp_research_scope_get before you launch it again,',
  'and tell the person if it cannot be launched.',
].join(' ')

/** A binder refusal the agent must not retry, with its code first for the model's own logic. */
export const deepWaterToolRefusal = (code: string, message: string): string => `${code}: ${message}`
