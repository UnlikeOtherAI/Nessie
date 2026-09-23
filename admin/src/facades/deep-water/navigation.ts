/**
 * How a person arrives at a DeepWater research brief (docs/navigation
 * overview, "Intent params are declared"). `?research=<runId>` is linkable
 * state on the conversation and Knowledge view routes: it says which brief the
 * screen shows over itself, is written with `replace`, and a reload lands on
 * the same brief. The question a new brief starts from never goes in a URL — a
 * doorway that pre-fills it (an older research card's "Run again", a failed
 * research's "Start again") hands it over in router state instead.
 */

export const RESEARCH_INTENT = 'research'

export const KNOWLEDGE_RESEARCH_VIEW_PATH = '/knowledge-base/views/deep-water-research'

/**
 * Where a research's brief opens when nothing on the current screen can open
 * it in place: over the conversation it belongs to, else over Knowledge ›
 * Research.
 */
export const researchBriefHref = (run: { id: string; origin: { channelId: string | null } }): string => {
  const search = `?${RESEARCH_INTENT}=${encodeURIComponent(run.id)}`
  return run.origin.channelId
    ? `/channels/${encodeURIComponent(run.origin.channelId)}${search}`
    : `${KNOWLEDGE_RESEARCH_VIEW_PATH}${search}`
}

const PREFILL_STATE_KEY = 'deepWaterResearchBrief'

export type ResearchBriefPrefill = { topic: string }

export const researchBriefPrefillState = (topic: string | undefined): Record<string, unknown> => ({
  [PREFILL_STATE_KEY]: { topic: topic ?? '' },
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export const readResearchBriefPrefill = (state: unknown): ResearchBriefPrefill | null => {
  if (!isRecord(state)) return null
  const prefill = state[PREFILL_STATE_KEY]
  if (!isRecord(prefill)) return null
  return { topic: typeof prefill.topic === 'string' ? prefill.topic : '' }
}
