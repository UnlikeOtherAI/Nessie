import { z } from 'zod'

/**
 * The DeepWater research-brief vocabulary: the seven negotiable settings, the
 * pillars and the question, exactly as the cross-repo contract defines them
 * (Water docs/plans/2026-09-22-deepwater-in-nessie/contract.md §3).
 *
 * Nessie's API and views speak camel case; Ledger's MCP and REST wire speak
 * snake case, and `toLedgerBriefSettings` / `DEEP_WATER_BRIEF_SETTING_WIRE_KEYS`
 * are the only translation between the two. Output tier (always the full
 * report) and visibility are fixed by the launch, never negotiated in a brief.
 */

/**
 * Ledger's `deepwaterLanguageCodes` (ledger `api/src/services/research-contract.ts`),
 * in Ledger's order. Water pins its brief enum to the same list, and the
 * DeepWater manifest's contract test deep-equals the language enum it builds
 * from this list against Ledger's `tools/list` fixture, so a drift fails there.
 */
export const DEEP_WATER_LANGUAGE_CODES = [
  'en', 'zh', 'es', 'ar', 'hi', 'fr', 'pt', 'ru', 'de', 'ja', 'ko', 'it',
  'bn', 'my', 'fil', 'gu', 'id', 'jv', 'kn', 'km', 'lo', 'ms', 'ml', 'mn',
  'mr', 'ne', 'pa', 'si', 'ta', 'te', 'th', 'ur', 'uz', 'vi', 'he', 'ku',
  'fa', 'tr', 'am', 'ha', 'ig', 'mg', 'so', 'sw', 'yo', 'zu', 'sq', 'hy',
  'az', 'eu', 'be', 'bs', 'bg', 'ca', 'hr', 'cs', 'da', 'nl', 'et', 'fi',
  'gl', 'ka', 'el', 'hu', 'is', 'ga', 'kk', 'lv', 'lt', 'lb', 'mk', 'mt',
  'no', 'pl', 'ro', 'sr', 'sk', 'sl', 'sv', 'uk', 'cy', 'ht', 'mi',
] as const

/** The languages a report can be written in. */
export const DEEP_WATER_OUTPUT_LANGUAGES = [
  'en', 'cs', 'es', 'de', 'it', 'zh', 'ja', 'fr', 'pt', 'ar', 'ru', 'ko',
] as const

export const DeepWaterBriefDepthSchema = z.enum(['light', 'standard', 'deep', 'heavy'])
export type DeepWaterBriefDepth = z.infer<typeof DeepWaterBriefDepthSchema>

export const DeepWaterChapterDepthSchema = z.enum(['brief', 'standard', 'detailed', 'exhaustive'])
export type DeepWaterChapterDepth = z.infer<typeof DeepWaterChapterDepthSchema>

export const DeepWaterSearchQualitySchema = z.enum(['standard', 'premium'])
export type DeepWaterSearchQuality = z.infer<typeof DeepWaterSearchQualitySchema>

export const DeepWaterLanguageCodeSchema = z.enum(DEEP_WATER_LANGUAGE_CODES)
export type DeepWaterLanguageCode = z.infer<typeof DeepWaterLanguageCodeSchema>

export const DeepWaterOutputLanguageSchema = z.enum(DEEP_WATER_OUTPUT_LANGUAGES)
export type DeepWaterOutputLanguage = z.infer<typeof DeepWaterOutputLanguageSchema>

export const DeepWaterBriefRecencySchema = z.enum(['any', 'day', 'week', 'month', 'year'])
export type DeepWaterBriefRecency = z.infer<typeof DeepWaterBriefRecencySchema>

export const DeepWaterWritingStyleSchema = z.enum([
  'standard',
  'scientific',
  'literary',
  'newsweekly',
  'plain',
  'narrative',
  'explanatory',
  'executive',
])
export type DeepWaterWritingStyle = z.infer<typeof DeepWaterWritingStyleSchema>

const settingShape = {
  depth: DeepWaterBriefDepthSchema,
  chapterDepth: DeepWaterChapterDepthSchema,
  searchQuality: DeepWaterSearchQualitySchema,
  languages: z.array(DeepWaterLanguageCodeSchema).max(DEEP_WATER_LANGUAGE_CODES.length),
  outputLanguage: DeepWaterOutputLanguageSchema,
  recency: DeepWaterBriefRecencySchema,
  writingStyle: DeepWaterWritingStyleSchema,
}

/** All seven brief settings, as DeepWater normalises them (defaults filled in). */
export const DeepWaterBriefSettingsSchema = z.object(settingShape).strict()
export type DeepWaterBriefSettings = z.infer<typeof DeepWaterBriefSettingsSchema>

export type DeepWaterBriefSettingKey = keyof DeepWaterBriefSettings

/** camelCase view key → snake_case Ledger wire key. The one translation table. */
export const DEEP_WATER_BRIEF_SETTING_WIRE_KEYS = {
  depth: 'depth',
  chapterDepth: 'chapter_depth',
  searchQuality: 'search_quality',
  languages: 'languages',
  outputLanguage: 'output_language',
  recency: 'recency',
  writingStyle: 'writing_style',
} as const satisfies Record<DeepWaterBriefSettingKey, string>

export type DeepWaterBriefSettingWireKey =
  (typeof DEEP_WATER_BRIEF_SETTING_WIRE_KEYS)[DeepWaterBriefSettingKey]

export const DEEP_WATER_BRIEF_SETTING_KEYS = Object.keys(
  DEEP_WATER_BRIEF_SETTING_WIRE_KEYS,
) as DeepWaterBriefSettingKey[]

export const DeepWaterBriefSettingKeySchema = z.enum([
  'depth',
  'chapterDepth',
  'searchQuality',
  'languages',
  'outputLanguage',
  'recency',
  'writingStyle',
])

const WIRE_TO_VIEW_KEY = new Map<string, DeepWaterBriefSettingKey>(
  DEEP_WATER_BRIEF_SETTING_KEYS.map((key) => [DEEP_WATER_BRIEF_SETTING_WIRE_KEYS[key], key]),
)

/** The camelCase key for a Ledger wire key, or null for a key Nessie does not know. */
export const deepWaterBriefSettingKeyFromWire = (
  wireKey: string,
): DeepWaterBriefSettingKey | null => WIRE_TO_VIEW_KEY.get(wireKey) ?? null

/** DeepWater's defaults (contract §3), shown until the planner has proposed values. */
export const DEEP_WATER_DEFAULT_BRIEF_SETTINGS: DeepWaterBriefSettings = {
  depth: 'standard',
  chapterDepth: 'standard',
  searchQuality: 'standard',
  languages: [],
  outputLanguage: 'en',
  recency: 'any',
  writingStyle: 'standard',
}

/**
 * Settings seeded when a brief is opened: only the keys the requester chose,
 * each non-null. Every key sent becomes locked against the planner, so a
 * client never sends a key the person did not touch.
 */
export const DeepWaterBriefSettingsSeedSchema = DeepWaterBriefSettingsSchema.partial().strict()
export type DeepWaterBriefSettingsSeed = z.infer<typeof DeepWaterBriefSettingsSeedSchema>

/**
 * An edit: the keys the editor changed. A value sets the key and locks it; null
 * clears the value and the lock. An empty edit is refused rather than sent.
 */
export const DeepWaterBriefSettingsEditSchema = z
  .object({
    depth: settingShape.depth.nullable().optional(),
    chapterDepth: settingShape.chapterDepth.nullable().optional(),
    searchQuality: settingShape.searchQuality.nullable().optional(),
    languages: settingShape.languages.nullable().optional(),
    outputLanguage: settingShape.outputLanguage.nullable().optional(),
    recency: settingShape.recency.nullable().optional(),
    writingStyle: settingShape.writingStyle.nullable().optional(),
  })
  .strict()
  .refine((edit) => Object.keys(edit).length > 0, {
    message: 'A settings edit must change at least one setting.',
  })
export type DeepWaterBriefSettingsEdit = z.infer<typeof DeepWaterBriefSettingsEditSchema>

/** The research question. */
export const DeepWaterBriefTopicSchema = z.string().trim().min(3).max(20_000)

/** Background the requester gives the planner. */
export const DeepWaterBriefContextSchema = z.string().max(50_000)

/** Pillars, in order; each becomes a chapter of the report. An edit replaces the list. */
export const DeepWaterBriefPillarsSchema = z.array(z.string().trim().min(1).max(500)).min(1).max(60)

/** A reply to the planner. */
export const DeepWaterBriefMessageSchema = z.string().trim().min(1).max(20_000)

/**
 * Map a seed or an edit onto Ledger's snake_case `settings` argument. Only the
 * keys present on the input are written — absent stays absent and null stays
 * null — because every key sent to Ledger becomes a lock.
 */
export const toLedgerBriefSettings = (
  settings: Partial<{ [K in DeepWaterBriefSettingKey]: DeepWaterBriefSettings[K] | null }>,
): Record<string, unknown> => {
  const wire: Record<string, unknown> = {}
  for (const key of DEEP_WATER_BRIEF_SETTING_KEYS) {
    if (Object.prototype.hasOwnProperty.call(settings, key) && settings[key] !== undefined) {
      wire[DEEP_WATER_BRIEF_SETTING_WIRE_KEYS[key]] = settings[key]
    }
  }
  return wire
}
