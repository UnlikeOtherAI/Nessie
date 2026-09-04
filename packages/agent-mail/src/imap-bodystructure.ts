/**
 * The small, deliberately strict subset of IMAP BODYSTRUCTURE needed by the
 * live mail reader.  It describes parts without downloading their payloads.
 */
export type ImapBodyPart = {
  bytes: number
  charset: string | null
  contentType: string
  encoding: string | null
  filename: string | null
  section: string
  textKind: 'html' | 'plain' | null
}

type ImapValue = string | null | ImapValue[]

/** A hostile server must not turn MIME metadata into an unbounded parser walk. */
const MAX_BODYSTRUCTURE_DEPTH = 32
const MAX_BODYSTRUCTURE_PARTS = 100

const atom = (value: ImapValue | undefined): string | null =>
  typeof value === 'string' ? value : null

const list = (value: ImapValue | undefined): ImapValue[] => Array.isArray(value) ? value : []

const parameters = (value: ImapValue | undefined): Map<string, string> => {
  const values = list(value)
  const result = new Map<string, string>()
  for (let index = 0; index + 1 < values.length; index += 2) {
    const key = atom(values[index])
    const item = atom(values[index + 1])
    if (key && item !== null) result.set(key.toUpperCase(), item)
  }
  return result
}

const tokenize = (input: string): ImapValue | null => {
  let index = 0
  const whitespace = (): void => { while (/\s/.test(input[index] ?? '')) index += 1 }
  const value = (depth: number): { valid: boolean; value: ImapValue } => {
    if (depth > MAX_BODYSTRUCTURE_DEPTH) return { valid: false, value: null }
    whitespace()
    if (input[index] === '(') {
      index += 1
      const values: ImapValue[] = []
      for (;;) {
        whitespace()
        if (input[index] === ')') { index += 1; return { valid: true, value: values } }
        if (index >= input.length) return { valid: false, value: null }
        const child = value(depth + 1)
        if (!child.valid) return child
        values.push(child.value)
      }
    }
    if (input[index] === '"') {
      index += 1
      let output = ''
      while (index < input.length && input[index] !== '"') {
        if (input[index] === '\\') index += 1
        output += input[index] ?? ''
        index += 1
      }
      if (input[index] !== '"') return { valid: false, value: null }
      index += 1
      return { valid: true, value: output }
    }
    const start = index
    while (index < input.length && !/[\s()]/.test(input[index] ?? '')) index += 1
    const output = input.slice(start, index)
    if (!output) return { valid: false, value: null }
    return { valid: true, value: output.toUpperCase() === 'NIL' ? null : output }
  }
  const parsed = value(0)
  whitespace()
  return parsed.valid && index === input.length ? parsed.value : null
}

const bodyStructureValue = (response: string): ImapValue | null => {
  const marker = /\bBODYSTRUCTURE\s+/i.exec(response)
  if (!marker) return null
  const start = (marker.index ?? 0) + marker[0].length
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = start; index < response.length; index += 1) {
    const char = response[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') { quoted = true; continue }
    if (char === '(') {
      depth += 1
      if (depth > MAX_BODYSTRUCTURE_DEPTH) return null
    }
    if (char === ')') {
      depth -= 1
      if (depth === 0) return tokenize(response.slice(start, index + 1))
    }
  }
  return null
}

const disposition = (value: ImapValue | undefined): { filename: string | null; kind: string | null } => {
  const values = list(value)
  const kind = atom(values[0])?.toUpperCase() ?? null
  const filename = parameters(values[1]).get('FILENAME') ?? null
  return { filename, kind }
}

const collect = (value: ImapValue, section: string, output: ImapBodyPart[], depth = 0): boolean => {
  if (depth > MAX_BODYSTRUCTURE_DEPTH || output.length >= MAX_BODYSTRUCTURE_PARTS) return false
  const values = list(value)
  if (values.length === 0) return true
  if (Array.isArray(values[0])) {
    let childCount = 0
    while (Array.isArray(values[childCount])) childCount += 1
    for (let index = 0; index < childCount; index += 1) {
      if (!collect(values[index] as ImapValue[], `${section}${index + 1}.`, output, depth + 1)) return false
    }
    return true
  }
  const type = atom(values[0])?.toLowerCase()
  const subtype = atom(values[1])?.toLowerCase()
  if (!type || !subtype) return true
  const params = parameters(values[2])
  const encoding = atom(values[5])
  const bytes = Number(atom(values[6]))
  const dispositionIndex = type === 'text' ? 9 : type === 'message' && subtype === 'rfc822' ? 10 : 8
  const bodyDisposition = disposition(values[dispositionIndex])
  const filename = bodyDisposition.filename ?? params.get('NAME') ?? null
  const textKind = type === 'text' && subtype === 'plain'
    ? 'plain'
    : type === 'text' && subtype === 'html' ? 'html' : null
  output.push({
    bytes: Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : 0,
    charset: params.get('CHARSET') ?? null,
    contentType: `${type}/${subtype}`,
    encoding,
    filename,
    // A top-level single-part message has no numeric MIME part. RFC 3501 names
    // its displayable body `TEXT`; multipart children are numbered from 1.
    section: section ? section.slice(0, -1) : 'TEXT',
    textKind,
  })
  return output.length <= MAX_BODYSTRUCTURE_PARTS
}

/** Parse BODYSTRUCTURE from one FETCH response; malformed structures are ignored. */
export const parseImapBodyStructure = (response: string): ImapBodyPart[] => {
  const value = bodyStructureValue(response)
  if (!value) return []
  const output: ImapBodyPart[] = []
  return collect(value, '', output) ? output : []
}

export const imapAttachmentParts = (parts: readonly ImapBodyPart[]): ImapBodyPart[] =>
  parts.filter((part) => part.textKind === null || part.filename !== null)

export const imapTextParts = (parts: readonly ImapBodyPart[]): ImapBodyPart[] =>
  parts.filter((part) => part.textKind !== null && part.filename === null)
