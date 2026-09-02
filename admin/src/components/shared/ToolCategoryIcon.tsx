import type { ToolRegistrySource } from '@nessie/schemas'
import { TOOL_SOURCE_TONE_CLASS } from './ToolBadge'

/**
 * `ToolCategoryIcon` renders the leading glyph for a tool row. The glyph is
 * keyed on `source` so the registry list communicates provenance even before
 * the user reads the badge text — important when an org has dozens of MCP
 * servers installed.
 *
 * Per §8 of provider-system-and-frontend-architecture.md. The colour ramp is
 * `ToolBadge`'s `TOOL_SOURCE_TONE_CLASS` — this used to keep its own copy of
 * the identical `Record<ToolRegistrySource, string>`, so the two could (and
 * did) drift silently. It stays a 36px avatar square rather than a `Pill`:
 * `Pill`'s two radii are a capsule and a 4px chip, neither is this shape.
 */
type ToolCategoryIconProps = {
  source: ToolRegistrySource
}

const SOURCE_GLYPHS: Record<ToolRegistrySource, string> = {
  'builtin': 'B',
  'custom': 'C',
  'executor': 'E',
  'mcp-remote': 'M',
  'interactive-session': 'I',
}

export const ToolCategoryIcon = ({ source }: ToolCategoryIconProps) => (
  <span
    className={[
      'inline-flex h-9 w-9 items-center justify-center rounded-2xl',
      'text-sm font-semibold',
      TOOL_SOURCE_TONE_CLASS[source],
    ].join(' ')}
  >
    {SOURCE_GLYPHS[source]}
  </span>
)
