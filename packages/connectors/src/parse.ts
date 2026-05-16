import { ManifestParseError } from './errors.js'
import { parseJsonManifest } from './formats/json.js'
import { parseMarkdownManifest } from './formats/md.js'
import { parseYamlManifest } from './formats/yaml.js'

export type ManifestFormat = 'json' | 'yaml' | 'md'

/**
 * Parse a manifest blob into a raw JS value, without schema validation. Pass
 * `hint` when the format is known; otherwise the format is sniffed from the
 * payload.
 */
export const parseManifest = (
  input: string | Buffer | Uint8Array,
  hint?: ManifestFormat,
): unknown => {
  const text = coerceToString(input)
  const format = hint ?? detectFormat(text)
  switch (format) {
    case 'json':
      return parseJsonManifest(text)
    case 'yaml':
      return parseYamlManifest(text)
    case 'md':
      return parseMarkdownManifest(text)
    default: {
      const exhaustive: never = format
      throw new ManifestParseError(
        'unknown',
        `unsupported manifest format: ${String(exhaustive)}`,
      )
    }
  }
}

const coerceToString = (input: string | Buffer | Uint8Array): string => {
  if (typeof input === 'string') {
    return input
  }
  if (Buffer.isBuffer(input)) {
    return input.toString('utf8')
  }
  return Buffer.from(input).toString('utf8')
}

const detectFormat = (text: string): ManifestFormat => {
  const trimmed = stripBom(text).trimStart()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return 'json'
  }
  if (trimmed.startsWith('---')) {
    return 'md'
  }
  return 'yaml'
}

const stripBom = (text: string): string =>
  text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
