import { z } from 'zod'

/**
 * Plain-language lines for a Zod object, built from its `.describe()` texts.
 *
 * The Agent Designer's catalogue and the agent tools describe a parameter from
 * the schema that validates it, never from prose somebody has to remember to
 * edit (`global-agent-catalogue.ts` forbids hand-written parameter prose).
 * This is how: each field reads as its name, whether it may be left out, its
 * shape, its default and its description, with nested fields and the forms a
 * union accepts indented beneath it as bullets.
 */

type Unwrapped = {
  defaultValue?: unknown
  description?: string
  nullable: boolean
  optional: boolean
  schema: z.ZodTypeAny
}

/** Peel the wrappers that change how a field may be given, not what it is. */
const unwrap = (input: z.ZodTypeAny): Unwrapped => {
  let schema = input
  let description = input.description
  let defaultValue: unknown
  let nullable = false
  let optional = false
  for (;;) {
    if (schema instanceof z.ZodOptional) {
      optional = true
      schema = schema.unwrap()
    } else if (schema instanceof z.ZodNullable) {
      nullable = true
      schema = schema.unwrap()
    } else if (schema instanceof z.ZodDefault) {
      optional = true
      defaultValue = schema._def.defaultValue()
      schema = schema.removeDefault()
    } else if (schema instanceof z.ZodEffects) {
      schema = schema.innerType()
    } else {
      break
    }
    description ??= schema.description
  }
  return { defaultValue, description, nullable, optional, schema }
}

const unionOptions = (schema: z.ZodTypeAny): readonly z.ZodTypeAny[] | null =>
  schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion
    ? schema.options as readonly z.ZodTypeAny[]
    : null

/** A union whose every form is an object: its forms are listed, one per line. */
const objectForms = (schema: z.ZodTypeAny): z.AnyZodObject[] | null => {
  const options = unionOptions(schema)?.map((option) => unwrap(option).schema)
  return options?.every((option) => option instanceof z.ZodObject)
    ? options as z.AnyZodObject[]
    : null
}

const numberLabel = (schema: z.ZodNumber): string => {
  const kind = schema.isInt ? 'whole number' : 'number'
  const { maxValue: max, minValue: min } = schema
  if (min !== null && max !== null) return `${kind} ${min}–${max}`
  if (min !== null) return `${kind} of at least ${min}`
  return max !== null ? `${kind} of at most ${max}` : kind
}

const label = (schema: z.ZodTypeAny): string => {
  if (schema instanceof z.ZodString) return schema.isUUID ? 'id' : 'text'
  if (schema instanceof z.ZodNumber) return numberLabel(schema)
  if (schema instanceof z.ZodBoolean) return 'true or false'
  if (schema instanceof z.ZodEnum) return (schema.options as string[]).join(' | ')
  if (schema instanceof z.ZodLiteral) return JSON.stringify(schema.value)
  if (schema instanceof z.ZodArray) {
    const min = (schema._def as { minLength: { value: number } | null }).minLength?.value
    const count = min ? ` (at least ${min})` : ''
    const element = unwrap(schema.element).schema
    return objectForms(element)
      ? `list${count}, each one of the forms below`
      : `list of ${label(element)}${count}`
  }
  if (objectForms(schema)) return 'one of the forms below'
  const options = unionOptions(schema)
  if (options) return options.map((option) => label(unwrap(option).schema)).join(' or ')
  if (schema instanceof z.ZodObject || schema instanceof z.ZodRecord) return 'object'
  return 'any value'
}

/** One form of a union, as it is written: `{category: in_progress | review}`. */
const formLabel = (form: z.AnyZodObject): string =>
  `{${Object.entries(form.shape as Record<string, z.ZodTypeAny>)
    .map(([key, field]) => `${key}: ${label(unwrap(field).schema)}`)
    .join(', ')}}`

const formDescription = (form: z.AnyZodObject): string | undefined => {
  if (form.description) return form.description
  const fields = Object.values(form.shape as Record<string, z.ZodTypeAny>)
  return fields.length === 1 ? unwrap(fields[0]!).description : undefined
}

const shownDefault = (value: unknown): boolean =>
  value !== undefined
  && !(typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 0)

const bullet = (depth: number, text: string): string => `${'  '.repeat(depth)}- ${text}`

const nestedLines = (schema: z.ZodTypeAny, depth: number): string[] => {
  if (schema instanceof z.ZodObject) return describeObjectFields(schema, depth)
  if (schema instanceof z.ZodArray) return nestedLines(unwrap(schema.element).schema, depth)
  const forms = objectForms(schema)
  if (!forms) return []
  return forms.map((form) => {
    const description = formDescription(form)
    return bullet(depth, `${formLabel(form)}${description ? ` — ${description}` : ''}`)
  })
}

const describeField = (key: string, field: z.ZodTypeAny, depth: number): string[] => {
  const facts = unwrap(field)
  const shape = [
    label(facts.schema),
    ...(facts.nullable ? ['or null'] : []),
    ...(shownDefault(facts.defaultValue) ? [`default ${JSON.stringify(facts.defaultValue)}`] : []),
  ].join(', ')
  return [
    bullet(
      depth,
      `${key}${facts.optional ? ' (optional)' : ''}: ${shape}`
      + (facts.description ? ` — ${facts.description}` : ''),
    ),
    ...nestedLines(facts.schema, depth + 1),
  ]
}

/**
 * Every field of `object`, as bullets indented by `depth`, nested fields and a
 * union's forms beneath their field. A field without a description still reads
 * as its name and shape, so a missing `.describe()` shows up in the text rather
 * than dropping the field.
 */
export const describeObjectFields = (object: z.AnyZodObject, depth = 0): string[] =>
  Object.entries(object.shape as Record<string, z.ZodTypeAny>)
    .flatMap(([key, field]) => describeField(key, field, depth))

/**
 * The paths of every field in `object`, nested ones included, that carries no
 * description. A test holds each generated schema to an empty list.
 */
export const listUndescribedFields = (object: z.AnyZodObject, prefix = ''): string[] =>
  Object.entries(object.shape as Record<string, z.ZodTypeAny>).flatMap(([key, field]) => {
    const path = `${prefix}${key}`
    const facts = unwrap(field)
    let inner = facts.schema
    while (inner instanceof z.ZodArray) inner = unwrap(inner.element).schema
    const own = facts.description ? [] : [path]
    if (inner instanceof z.ZodObject) return [...own, ...listUndescribedFields(inner, `${path}.`)]
    // A union's form reads as one line, so the form (or its one field) is what
    // carries the description.
    const forms = objectForms(inner) ?? []
    return [
      ...own,
      ...forms.filter((form) => !formDescription(form)).map((form) => `${path}.${formLabel(form)}`),
    ]
  })
