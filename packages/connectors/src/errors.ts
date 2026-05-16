/**
 * Typed errors emitted by the connectors package. Callers should match on the
 * `kind` discriminator rather than parsing messages.
 */

export type ManifestErrorIssue = {
  /** Dot-path to the offending field, empty string for the root. */
  path: string
  message: string
}

/**
 * Raised when raw manifest text cannot be parsed into a JS value at all
 * (malformed JSON / YAML, missing or bad frontmatter, unknown format).
 */
export class ManifestParseError extends Error {
  public readonly kind = 'ManifestParseError' as const

  public readonly format: 'json' | 'yaml' | 'md' | 'unknown'

  /** 1-indexed line number of the parse failure, when known. */
  public readonly line?: number

  /** 1-indexed column of the parse failure, when known. */
  public readonly column?: number

  public constructor(
    format: ManifestParseError['format'],
    message: string,
    location?: { line?: number; column?: number },
  ) {
    super(message)
    this.name = 'ManifestParseError'
    this.format = format
    this.line = location?.line
    this.column = location?.column
  }
}

/**
 * Raised when the parsed value does not satisfy the NessieToolBundle schema or
 * its signature does not verify.
 */
export class ManifestValidationError extends Error {
  public readonly kind = 'ManifestValidationError' as const

  public readonly issues: ManifestErrorIssue[]

  public constructor(message: string, issues: ManifestErrorIssue[]) {
    super(message)
    this.name = 'ManifestValidationError'
    this.issues = issues
  }
}
