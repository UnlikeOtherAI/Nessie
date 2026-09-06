import { BUILTIN_TOOL_DEFINITIONS } from '@nessie/runtime'

/**
 * Undo a model's double-encoded tool arguments.
 *
 * Some models emit a nested object or array parameter as a JSON *string* inside
 * the arguments object: `{"dashboardId":"…","definition":"{\"kind\":\"stat\"}"}`
 * rather than `{"dashboardId":"…","definition":{"kind":"stat"}}`. The connector
 * parses the outer JSON (`safeParseJson`), so the outer shape is right and the
 * inner value is still a string — and the tool's own zod parse then refuses it
 * with `Expected object, received string`.
 *
 * It is not random. It tracks the schema: a parameter declared `type: "object"`
 * with no `properties` (or `items: { type: "object" }`) gives the model no
 * structure to emit, so it falls back to serializing. That is why the split the
 * Dashboard Designer reported is so clean — `dashboard_source_import` and
 * `dashboard_create` take only strings and work, while `dashboard_widget_add`,
 * `dashboard_widget_move`, `dashboard_source_probe`, `dashboard_source_create`
 * and `dashboard_presentation_update` take object/array parameters and fail
 * every time. Twenty-seven builtin parameters across the workflow, card, agent
 * and dashboard tools have that shape.
 *
 * Correcting here rather than in each tool keeps it one rule: the declared type
 * is the authority, a value is only ever replaced when the parsed JSON is the
 * kind the schema asked for, and anything else is left exactly as it arrived so
 * the tool's own validation still produces the error a caller should see.
 */

type JsonKind = 'array' | 'object'

const declaredKind = (schema: unknown): JsonKind | null => {
  if (!schema || typeof schema !== 'object') return null
  const type = (schema as { type?: unknown }).type
  return type === 'object' ? 'object' : type === 'array' ? 'array' : null
}

const kindOf = (value: unknown): JsonKind | null => {
  if (Array.isArray(value)) return 'array'
  if (value && typeof value === 'object') return 'object'
  return null
}

/** Parse only when the result is the kind the schema declared. */
const parseAs = (raw: string, want: JsonKind): unknown => {
  const trimmed = raw.trim()
  // Cheap guard so an ordinary string is never handed to JSON.parse.
  const opener = want === 'array' ? '[' : '{'
  if (!trimmed.startsWith(opener)) return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return kindOf(parsed) === want ? parsed : undefined
  } catch {
    return undefined
  }
}

const coerceItems = (value: unknown[], itemSchema: unknown): unknown[] => {
  const want = declaredKind(itemSchema)
  if (!want) return value
  return value.map((entry) => {
    if (typeof entry !== 'string') return entry
    const parsed = parseAs(entry, want)
    return parsed === undefined ? entry : parsed
  })
}

const builtinParameterSchemas = (
  toolName: string,
): Record<string, unknown> | null => {
  const definition = BUILTIN_TOOL_DEFINITIONS.find((tool) => tool.id === toolName)
  const parameters = definition?.parameters as { properties?: unknown } | undefined
  const properties = parameters?.properties
  return properties && typeof properties === 'object' && !Array.isArray(properties)
    ? properties as Record<string, unknown>
    : null
}

export const coerceJsonEncodedToolArguments = (
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> => {
  const properties = builtinParameterSchemas(toolName)
  if (!properties) return args

  let corrected: Record<string, unknown> | null = null
  for (const [key, value] of Object.entries(args)) {
    const schema = properties[key]
    const want = declaredKind(schema)
    if (!want) continue

    let next: unknown = value
    if (typeof value === 'string') {
      const parsed = parseAs(value, want)
      if (parsed !== undefined) next = parsed
    }
    // An array may also arrive as real array of stringified records, which is
    // the same fault one level down.
    if (want === 'array' && Array.isArray(next)) {
      next = coerceItems(next, (schema as { items?: unknown }).items)
    }
    if (next !== value) {
      corrected ??= { ...args }
      corrected[key] = next
    }
  }
  return corrected ?? args
}
