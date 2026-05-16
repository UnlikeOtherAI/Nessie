import { parse as parseYaml, YAMLParseError } from 'yaml'

import { ManifestParseError } from '../errors.js'

/**
 * Parse a YAML manifest string into a raw JS value. The `yaml` package returns
 * a structured error with `linePos` that we propagate as 1-indexed
 * line/column on `ManifestParseError`.
 */
export const parseYamlManifest = (text: string): unknown => {
  try {
    // `prettyErrors` must stay enabled (the default) so the thrown
    // `YAMLParseError` carries `linePos`; disabling it strips line/col.
    return parseYaml(text)
  } catch (cause) {
    if (cause instanceof YAMLParseError) {
      const start = cause.linePos?.[0]
      throw new ManifestParseError('yaml', cause.message, {
        line: start?.line,
        column: start?.col,
      })
    }
    const message = cause instanceof Error ? cause.message : String(cause)
    throw new ManifestParseError('yaml', message)
  }
}
