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

const declaredType = (schema: unknown): string | null => {
  if (!schema || typeof schema !== 'object') return null
  const type = (schema as { type?: unknown }).type
  return typeof type === 'string' ? type : null
}

const coerceScalar = (value: string, want: string | null): unknown => {
  if (want === 'boolean') {
    if (value === 'true') return true
    if (value === 'false') return false
    return undefined
  }
  if (want === 'number' || want === 'integer') {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    const num = Number(trimmed)
    if (!Number.isFinite(num)) return undefined
    if (want === 'integer' && !Number.isInteger(num)) return undefined
    return num
  }
  return undefined
}

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

const declaredProperties = (inputSchema: unknown): Record<string, unknown> | null => {
  const properties = (inputSchema as { properties?: unknown } | null | undefined)?.properties
  return properties && typeof properties === 'object' && !Array.isArray(properties)
    ? properties as Record<string, unknown>
    : null
}

export type ToolArgumentCoercion = {
  /**
   * Only turn strings into the declared `number`, `integer` or `boolean`, and
   * never parse a string into an object or an array. The executor uses it on a
   * local program's own arguments, whose grammar is the program's: the worker
   * shapes a scalar to the type the program advertised and leaves the rest.
   */
  scalarsOnly?: boolean
}

/**
 * The same correction against any JSON Schema, for tools that are not
 * builtins: an executor tool's model-facing schema, or the input schema a local
 * program advertised for one of its tools. Only the schema's top-level
 * `properties` are consulted.
 */
export const coerceToolArgumentsToSchema = (
  inputSchema: unknown,
  args: Record<string, unknown> | string,
  options: ToolArgumentCoercion = {},
): Record<string, unknown> => {
  // The whole arguments object may itself arrive as a JSON-encoded string.
  if (typeof args === 'string') {
    const trimmed = args.trim()
    if (trimmed.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(trimmed)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>
        }
      } catch {
        return {} as Record<string, unknown>
      }
    }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return {} as Record<string, unknown>
  }
  const properties = declaredProperties(inputSchema)
  if (!properties) return args

  let corrected: Record<string, unknown> | null = null
  for (const [key, value] of Object.entries(args)) {
    const schema = properties[key]
    const want = options.scalarsOnly ? null : declaredKind(schema)

    let next: unknown = value
    if (typeof value === 'string') {
      if (want) {
        const parsed = parseAs(value, want)
        if (parsed !== undefined) next = parsed
      } else {
        // Scalar declared types: "true"/"false" and numeric strings.
        const scalar = coerceScalar(value, declaredType(schema))
        if (scalar !== undefined) next = scalar
      }
    }
    // An array may also arrive as real array of stringified records, which is
    // the same fault one level down.
    if (want === 'array' && Array.isArray(next)) {
      next = coerceItems(next, (schema as { items?: unknown }).items)
    }
    // A declared nested object is corrected by its own properties the same
    // way: `limits: { ticketUsd: "20" }` is the scalar fault one level down.
    if (kindOf(next) === 'object' && declaredProperties(schema)) {
      next = coerceToolArgumentsToSchema(schema, next as Record<string, unknown>, options)
    }
    if (next !== value) {
      corrected ??= { ...args }
      corrected[key] = next
    }
  }
  return corrected ?? args
}

export const coerceJsonEncodedToolArguments = (
  toolName: string,
  args: Record<string, unknown> | string,
): Record<string, unknown> => coerceToolArgumentsToSchema(
  BUILTIN_TOOL_DEFINITIONS.find((tool) => tool.id === toolName)?.parameters,
  args,
)
