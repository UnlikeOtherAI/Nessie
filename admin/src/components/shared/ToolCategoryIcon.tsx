import type { ToolRegistrySource } from '@nessie/schemas'

/**
 * `ToolCategoryIcon` renders the leading glyph for a tool row. The glyph is
 * keyed on `source` so the registry list communicates provenance even before
 * the user reads the badge text — important when an org has dozens of MCP
 * servers installed.
 *
 * Per §8 of provider-system-and-frontend-architecture.md.
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

const SOURCE_TONE: Record<ToolRegistrySource, string> = {
  'builtin': 'bg-[color:var(--accent-soft)] text-[color:var(--accent)]',
  'custom': 'bg-[color:var(--warning-soft)] text-[color:var(--warning-text)]',
  'executor': 'bg-[color:var(--info-soft)] text-[color:var(--info-text)]',
  'mcp-remote': 'bg-[color:var(--accent-soft)] text-[color:var(--thinking)]',
  'interactive-session': 'bg-[color:var(--info-soft)] text-[color:var(--info-text)]',
}

export const ToolCategoryIcon = ({ source }: ToolCategoryIconProps) => (
  <span
    className={[
      'inline-flex h-9 w-9 items-center justify-center rounded-2xl',
      'text-sm font-semibold',
      SOURCE_TONE[source],
    ].join(' ')}
  >
    {SOURCE_GLYPHS[source]}
  </span>
)
