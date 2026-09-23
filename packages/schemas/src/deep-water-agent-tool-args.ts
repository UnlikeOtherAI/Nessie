import { z } from 'zod'

import {
  DEEP_WATER_LANGUAGE_CODES,
  DeepWaterBriefContextSchema,
  DeepWaterBriefDepthSchema,
  DeepWaterBriefPillarsSchema,
  DeepWaterBriefRecencySchema,
  DeepWaterBriefTopicSchema,
  DeepWaterChapterDepthSchema,
  DeepWaterLanguageCodeSchema,
  DeepWaterOutputLanguageSchema,
  DeepWaterSearchQualitySchema,
  DeepWaterWritingStyleSchema,
  type DeepWaterBriefSettingsSeed,
} from './deep-water-brief-vocabulary.js'

/**
 * What an agent passes to DeepWater's brief tools, read by the worker's run
 * binder before a call reaches Ledger (Water plan nessie.md §7.4). The agent
 * speaks Ledger's own wire vocabulary — snake_case settings — because the
 * tools it sees are Ledger's `tools/list`; the binder keeps what it stores in
 * Nessie's camelCase vocabulary, the one every brief view is built from.
 */

/** Seed settings on the wire: any subset, each a value (every key sent becomes a lock). */
const WireSeedSettingsSchema = z
  .object({
    depth: DeepWaterBriefDepthSchema.optional(),
    chapter_depth: DeepWaterChapterDepthSchema.optional(),
    search_quality: DeepWaterSearchQualitySchema.optional(),
    languages: z.array(DeepWaterLanguageCodeSchema).max(DEEP_WATER_LANGUAGE_CODES.length).optional(),
    output_language: DeepWaterOutputLanguageSchema.optional(),
    recency: DeepWaterBriefRecencySchema.optional(),
    writing_style: DeepWaterWritingStyleSchema.optional(),
  })
  .strict()

const toSeed = (wire: z.infer<typeof WireSeedSettingsSchema>): DeepWaterBriefSettingsSeed => ({
  ...(wire.depth !== undefined ? { depth: wire.depth } : {}),
  ...(wire.chapter_depth !== undefined ? { chapterDepth: wire.chapter_depth } : {}),
  ...(wire.search_quality !== undefined ? { searchQuality: wire.search_quality } : {}),
  ...(wire.languages !== undefined ? { languages: wire.languages } : {}),
  ...(wire.output_language !== undefined ? { outputLanguage: wire.output_language } : {}),
  ...(wire.recency !== undefined ? { recency: wire.recency } : {}),
  ...(wire.writing_style !== undefined ? { writingStyle: wire.writing_style } : {}),
})

/**
 * An agent's `research_scope_start` arguments, as the brief it opens stores
 * them (`input_json`). Background that is only whitespace is no background, as
 * Ledger treats it; an empty settings object seeds nothing.
 */
export const DeepWaterScopeStartToolArgsSchema = z
  .object({
    topic: DeepWaterBriefTopicSchema,
    context: DeepWaterBriefContextSchema.optional(),
    pillars: DeepWaterBriefPillarsSchema.optional(),
    settings: WireSeedSettingsSchema.optional(),
  })
  .strict()
  .transform((args) => {
    const context = args.context?.trim() ?? ''
    const settings = args.settings ? toSeed(args.settings) : null
    return {
      topic: args.topic,
      context: context.length > 0 ? context : null,
      pillars: args.pillars ?? null,
      settings: settings && Object.keys(settings).length > 0 ? settings : null,
    }
  })
export type DeepWaterScopeStartToolArgs = z.output<typeof DeepWaterScopeStartToolArgsSchema>

/** The research an id-bearing brief tool names; null when the call names none. */
export const deepWaterToolResearchId = (args: Record<string, unknown>): string | null =>
  typeof args.id === 'string' && args.id.length > 0 ? args.id : null

/**
 * Does this call change the brief's content? A launch or a reply that sends
 * pillars or settings edits the brief (contract D4); a reply always carries the
 * agent's own words to the planner.
 */
export const deepWaterToolEditsBrief = (args: Record<string, unknown>): boolean =>
  args.pillars !== undefined || args.settings !== undefined

/** Only a person may publish a research on research.deepwater.live (overview §8). */
export const deepWaterToolAsksToPublish = (args: Record<string, unknown>): boolean =>
  args.public === true
