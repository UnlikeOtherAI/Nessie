/**
 * An exact-match list of browser origins, e.g. `NESSIE_LANDING_ORIGIN`.
 *
 * Read the way `NESSIE_CORS_ORIGINS` is — comma-separated, each entry trimmed,
 * empties dropped — but strict about what an entry is. Each must parse as an
 * `http:` or `https:` URL carrying nothing beyond scheme, host and port; it is
 * stored as its serialised `URL#origin` (lower-cased host, default port
 * dropped, no trailing slash), which is exactly what a browser sends in
 * `Origin`. A path, query, fragment, credentials or anything unparseable
 * refuses the whole configuration: an entry that silently never matches is a
 * misconfiguration nobody notices until the feature is missing in production.
 */
export class OriginAllowlistError extends Error {
  constructor(source: string, entry: string, reason: string) {
    super(`${source}: "${entry}" is not a bare origin (${reason}); expected e.g. https://example.com`)
    this.name = 'OriginAllowlistError'
  }
}

export const normalizeAllowlistOrigin = (entry: string, source: string): string => {
  let url: URL
  try {
    url = new URL(entry)
  } catch {
    throw new OriginAllowlistError(source, entry, 'not a URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new OriginAllowlistError(source, entry, 'scheme must be http or https')
  }
  if (url.username || url.password) {
    throw new OriginAllowlistError(source, entry, 'credentials are not allowed')
  }
  if (url.pathname !== '/' || url.search || url.hash || entry.endsWith('?') || entry.endsWith('#')) {
    throw new OriginAllowlistError(source, entry, 'a path, query or fragment is not allowed')
  }
  return url.origin
}

/** A config-file entry is accepted only already in its normalised form. */
export const isBareOrigin = (value: string): boolean => {
  try {
    return normalizeAllowlistOrigin(value, 'origin') === value
  } catch {
    return false
  }
}

export const parseOriginAllowlist =(value: string | undefined, source: string): string[] => {
  const origins = new Set<string>()
  for (const raw of value?.split(',') ?? []) {
    const entry = raw.trim()
    if (entry) origins.add(normalizeAllowlistOrigin(entry, source))
  }
  return [...origins]
}
