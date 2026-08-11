/**
 * RFC 8785-compatible canonical JSON for the finite descriptor/enrollment
 * grammar. The schemas permit JSON primitives, finite integers, arrays, and
 * plain objects only; rejecting every other JavaScript value avoids signing a
 * lossy representation.
 */
export const canonicalExecutorJson = (value: unknown): string => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Cannot canonicalize non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalExecutorJson).join(',')}]`
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalExecutorJson(record[key])}`
    )).join(',')}}`
  }
  throw new TypeError('Cannot canonicalize unsupported value')
}

export const canonicalExecutorPayload = (
  domain: string,
  value: unknown,
): Buffer => Buffer.from(`${domain}\n${canonicalExecutorJson(value)}`, 'utf8')
