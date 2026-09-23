import {
  DEEP_WATER_LANGUAGE_CODES,
  DEEP_WATER_OUTPUT_LANGUAGES,
  DeepWaterBriefDepthSchema,
  DeepWaterBriefRecencySchema,
  DeepWaterChapterDepthSchema,
  DeepWaterSearchQualitySchema,
  DeepWaterWritingStyleSchema,
} from '@nessie/schemas'

/**
 * The input schemas of the DeepWater tools, as JSON Schema, exactly as
 * Ledger's `tools/list` publishes them (Water plan contract §5.2). They are
 * built from Nessie's own brief vocabulary rather than copied, so the contract
 * test that deep-equals them against Ledger's fixture
 * (`deep-water.ledger-contract.json`) also proves the vocabulary — every
 * setting value and language code — matches Ledger's.
 *
 * Refinements Ledger enforces beyond JSON Schema (an edit must change a
 * setting; `base_revision` is required with edits) are not expressible here
 * and arrive as Ledger tool errors.
 */

type JsonSchema = Record<string, unknown>

const JSON_SCHEMA_DRAFT = 'http://json-schema.org/draft-07/schema#'

const stringEnum = (values: readonly string[]): JsonSchema => ({ type: 'string', enum: [...values] })

const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: 'null' }] })

const nonNegativeInteger: JsonSchema = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }

const researchId: JsonSchema = { type: 'string', minLength: 1, maxLength: 200 }

const pillars: JsonSchema = {
  minItems: 1,
  maxItems: 60,
  type: 'array',
  items: { type: 'string', minLength: 1, maxLength: 500 },
}

const settingSchemas: Record<string, JsonSchema> = {
  depth: stringEnum(DeepWaterBriefDepthSchema.options),
  chapter_depth: stringEnum(DeepWaterChapterDepthSchema.options),
  search_quality: stringEnum(DeepWaterSearchQualitySchema.options),
  languages: {
    maxItems: DEEP_WATER_LANGUAGE_CODES.length,
    type: 'array',
    items: stringEnum(DEEP_WATER_LANGUAGE_CODES),
  },
  output_language: stringEnum(DEEP_WATER_OUTPUT_LANGUAGES),
  recency: stringEnum(DeepWaterBriefRecencySchema.options),
  writing_style: stringEnum(DeepWaterWritingStyleSchema.options),
}

/** Seed settings: any subset, each a value. Every key sent becomes a lock. */
const seedSettings: JsonSchema = {
  type: 'object',
  properties: settingSchemas,
  additionalProperties: false,
}

/** Edit settings: only the changed keys; null clears a value and its lock. */
const editSettings: JsonSchema = {
  type: 'object',
  properties: Object.fromEntries(
    Object.entries(settingSchemas).map(([key, schema]) => [key, nullable(schema)]),
  ),
  additionalProperties: false,
}

const strictObject = (properties: Record<string, JsonSchema>, required: string[]): JsonSchema => ({
  type: 'object',
  properties,
  required,
  $schema: JSON_SCHEMA_DRAFT,
  additionalProperties: false,
})

/** Ledger's pre-brief tools declare plain (non-strict) objects. */
const plainObject = (properties: Record<string, JsonSchema>, required: string[]): JsonSchema => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
  $schema: JSON_SCHEMA_DRAFT,
})

export const deepWaterToolInputSchemas = {
  research_scope_start: strictObject({
    topic: { type: 'string', minLength: 3, maxLength: 20_000 },
    context: { type: 'string', maxLength: 50_000 },
    pillars,
    settings: seedSettings,
  }, ['topic']),
  research_scope_reply: strictObject({
    id: researchId,
    message: { type: 'string', minLength: 1, maxLength: 20_000 },
    base_revision: nonNegativeInteger,
    pillars,
    settings: editSettings,
  }, ['id', 'message']),
  research_scope_get: strictObject({
    id: researchId,
    include_transcript: { default: false, type: 'boolean' },
  }, ['id']),
  research_scope_launch: strictObject({
    id: researchId,
    revision: nonNegativeInteger,
    pillars,
    settings: editSettings,
    public: { type: 'boolean' },
  }, ['id', 'revision']),
  research_status: plainObject({ id: researchId }, ['id']),
  research_report: plainObject({ id: researchId }, ['id']),
  research_cancel: plainObject({ id: researchId }, ['id']),
  research_list: plainObject({
    limit: { default: 20, type: 'integer', minimum: 1, maximum: 100 },
  }, []),
} satisfies Record<string, JsonSchema>

export type DeepWaterToolName = keyof typeof deepWaterToolInputSchemas
